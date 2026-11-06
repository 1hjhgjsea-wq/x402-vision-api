/**
 * x402 付费端点 · 卖家服务端
 * 依赖: @circle-fin/x402-batching (v4), express, dotenv
 *
 * 核心逻辑：
 *  - 未付费请求 -> 中间件自动返回 402 Payment Required，并附带付款选项
 *  - 已付费请求 -> 中间件先与 Circle Gateway 结算，成功后才进业务逻辑
 *  - 业务逻辑 -> 转发到上游模型 API（可配置，默认智谱）
 */

import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';

const PORT = Number(process.env.PORT || 3000);
const SELLER_ADDRESS = (process.env.SELLER_ADDRESS || '').trim();
const UPSTREAM_BASE = (process.env.UPSTREAM_BASE || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || '';
const VISION_MODEL = process.env.VISION_MODEL || 'glm-4.6v-flash';
const PRICE_VISION = process.env.PRICE_VISION || '$0.02';
const LOG_FILE = path.resolve(process.env.LOG_FILE || './paid-calls.log');

// ---------- 启动前校验 ----------
if (!/^0x[a-fA-F0-9]{40}$/.test(SELLER_ADDRESS)) {
  console.error('[FATAL] SELLER_ADDRESS 未配置或格式非法（需 0x 开头的 40 位十六进制地址）');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '4mb' }));

const gateway = createGatewayMiddleware({ sellerAddress: SELLER_ADDRESS });

function recordPaidCall(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.error('[log] 写入失败', e.message);
  }
}

// ---------- 免费端点 ----------

// 健康检查：上架 Agent Marketplace 后平台会持续探测，必须始终可达
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    upstream_configured: UPSTREAMS.length > 0,
    upstream_count: UPSTREAMS.length,
    upstreams: UPSTREAMS.map(u => ({ name: u.name, model: u.model })),
    breaker: {
      open: Date.now() < breakerOpenUntil,
      consecutive_failures: consecutiveFailures,
      cooldown_remaining_ms: Math.max(0, breakerOpenUntil - Date.now())
    }
  });
});

// 服务自述：让 agent 在被发现后能读懂的说明书
app.get('/', (_req, res) => {
  res.json({
    service: 'Vision Describe API',
    description: 'Vision-language understanding over x402. POST an image and a question, get a short answer. Pay per call in USDC.',
    payment: 'x402 v2, USDC, settles via Circle Gateway',
    pay_to: SELLER_ADDRESS,
    endpoints: [
      {
        path: '/v1/vision/describe',
        method: 'POST',
        price: PRICE_VISION,
        body: { image: 'string (https URL or data:image/...;base64,...)', prompt: 'string (optional)' },
        returns: { text: 'string', model: 'string', tokens: 'number' }
      }
    ]
  });
});

// ---------- 上游调用（多供应商 + 指数退避重试） ----------
// UPSTREAMS 为 JSON 数组，形如：
// [{"name":"zhipu","base":"https://open.bigmodel.cn/api/paas/v4","key":"xxx","model":"glm-4.6v-flash"}]
// 未配置时回退到单个 UPSTREAM_BASE / UPSTREAM_KEY / VISION_MODEL
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 4);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 1500);

function parseUpstreams() {
  const raw = (process.env.UPSTREAMS || '').trim();
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      const ok = (Array.isArray(arr) ? arr : []).filter(u => u && u.base && u.key && u.model);
      if (ok.length) return ok.map((u, i) => ({ name: u.name || `up${i}`, base: u.base, key: u.key, model: u.model }));
      console.error('[warn] UPSTREAMS 为空或字段缺失，回退单上游配置');
    } catch (e) {
      console.error('[warn] UPSTREAMS 解析失败，回退单上游配置：', e.message);
    }
  }
  return UPSTREAM_KEY ? [{ name: 'default', base: UPSTREAM_BASE, key: UPSTREAM_KEY, model: VISION_MODEL }] : [];
}

const UPSTREAMS = parseUpstreams();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 熔断器 ----------
// 目的：上游整体不可用时，在任何收费动作之前就返回 503，避免"收了钱给报错"
const BREAKER_THRESHOLD = Number(process.env.BREAKER_THRESHOLD || 3);
const BREAKER_COOLDOWN_MS = Number(process.env.BREAKER_COOLDOWN_MS || 60000);
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

function breakerGuard(req, res, next) {
  if (Date.now() < breakerOpenUntil) {
    return res.status(503).json({
      error: 'upstream_degraded',
      detail: '上游模型整体不可用，本次请求未收费，请稍后重试',
      retry_after_ms: breakerOpenUntil - Date.now()
    });
  }
  next();
}

function markUpstreamOk() {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}

function markUpstreamFail() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    console.error(`[breaker] 连续失败 ${consecutiveFailures} 次，熔断 ${BREAKER_COOLDOWN_MS}ms`);
  }
}

async function upstreamVision(image, question) {
  const errors = [];
  for (const up of UPSTREAMS) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let status = 0;
      let detail = '';
      try {
        const r = await fetch(`${up.base.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${up.key}` },
          body: JSON.stringify({
            model: up.model,
            messages: [{
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: image } },
                { type: 'text', text: question }
              ]
            }]
          })
        });
        const raw = await r.text();
        if (r.ok) {
          const data = JSON.parse(raw);
          return {
            ok: true,
            text: data?.choices?.[0]?.message?.content ?? '',
            model: up.model,
            provider: up.name,
            tokens: data?.usage?.total_tokens ?? 0
          };
        }
        status = r.status;
        detail = raw.slice(0, 300);
        // 429 限流与 5xx 属可恢复，重试；其余（鉴权/参数）直接换下一家
        if (!(status === 429 || status >= 500)) break;
      } catch (e) {
        status = -1;
        detail = String(e.message || e);
      }
      errors.push(`${up.name}#${attempt}:${status}`);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
      }
    }
  }
  return { ok: false, errors };
}

// ---------- 付费端点 ----------

app.post('/v1/vision/describe', breakerGuard, gateway.require(PRICE_VISION), async (req, res) => {
  const { image, prompt } = req.body || {};

  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'missing_field', detail: 'body.image must be an https URL or a data: URL' });
  }
  if (!UPSTREAMS.length) {
    return res.status(503).json({ error: 'upstream_not_configured', detail: 'server has no upstream configured' });
  }

  const question = prompt || '用一段话描述这张图片的关键内容。';

  const result = await upstreamVision(image, question);

  if (!result.ok) {
    markUpstreamFail();
    return res.status(503).json({
      error: 'upstream_unavailable',
      detail: '所有上游重试后仍不可用，本次未产生可用结果',
      attempts: result.errors
    });
  }

  markUpstreamOk();
  recordPaidCall({ endpoint: '/v1/vision/describe', price: PRICE_VISION, tokens: result.tokens });

  return res.json({ text: result.text, model: result.model, provider: result.provider, tokens: result.tokens });
});

// ---------- 启动 ----------
app.listen(PORT, () => {
  console.log(`[x402] listening on http://localhost:${PORT}`);
  console.log(`[x402] payTo = ${SELLER_ADDRESS}`);
  console.log(`[x402] price = ${PRICE_VISION} per /v1/vision/describe`);
  console.log(`[x402] 自测: curl -i http://localhost:${PORT}/v1/vision/describe -X POST -H "Content-Type: application/json" -d "{\\"image\\":\\"https://example.com/a.jpg\\"}"`);
});
