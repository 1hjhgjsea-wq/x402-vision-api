---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: fe99db5c241880e7a5a3e7bee1664028_85f07563d9c611f19232525400248c00
    ReservedCode1: 47nHKoT4EEzW/KKf9wVANmDitcxrO3IFJ5GbH7Tdf+pmYZyTAR/vBv+za/wLSVHKyUC8xfHM3uLwUcLDdv3GqBPLTXtBvza87coaEdXEJSXe9azuEMijH1ELP5Y4eDIxTZ3Q7uvN+UIDJDKtREZ/pmJ//jmSLTaf3Qif0omQt5NwiloAPNLBjEwNhKA=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: fe99db5c241880e7a5a3e7bee1664028_85f07563d9c611f19232525400248c00
    ReservedCode2: 47nHKoT4EEzW/KKf9wVANmDitcxrO3IFJ5GbH7Tdf+pmYZyTAR/vBv+za/wLSVHKyUC8xfHM3uLwUcLDdv3GqBPLTXtBvza87coaEdXEJSXe9azuEMijH1ELP5Y4eDIxTZ3Q7uvN+UIDJDKtREZ/pmJ//jmSLTaf3Qif0omQt5NwiloAPNLBjEwNhKA=
---



# x402 付费端点 · 部署与上架手册

一套已经本地验证通过的 x402 卖家服务：别人（或 AI Agent）调用你的接口，按次付 USDC，无需注册、无需 API key、无月费。

## 已验证的事实

本机实测结果（非推测）：

| 项目 | 结果 |
|---|---|
| SDK 安装 | `@circle-fin/x402-batching@4.0.0` 安装成功 |
| 服务启动 | 正常，Node v22.12.0 可运行（官方建议 22.18+，实测 22.12 无报错） |
| 未付费请求 | 返回 `402 Payment Required`，带 `PAYMENT-REQUIRED` 头 |
| 付款选项数量 | 24 条（12 条链 × 2 个 Gateway 版本） |
| 接受的链 | Ethereum、Base、Polygon、Arbitrum、Optimism、Avalanche、Unichain、World Chain、Arc 等 12 条 |
| 金额换算 | `$0.02` → `amount: "20000"`（USDC 6 位小数），换算正确 |
| 结算方式 | x402 v2 `exact` scheme + Circle Gateway 批量结算 |

## 你需要提供什么

只有两样东西是必须的：

1. **EVM 收款地址**（`0x` 开头 40 位）。USDC 直接打进这个地址，只有你能控制。
   - 没有钱包就用 Circle CLI 生成一个 agent wallet，或在任意钱包（MetaMask/OKX）新建后只取地址。
   - ⚠️ 项目里 `.env` 现在填的是 `0x...dEaD`（销毁地址），**仅仅为了本地测试**，必须换成你自己的，否则钱打进去就再也拿不回来。
2. **一个公网可访问的部署**。Agent 要能访问你的 URL 才会付钱，`localhost` 不行。

## 启动

```bash
cd output/x402-paywall
# 1. 改 .env，把 SELLER_ADDRESS 换成你的地址，填上 UPSTREAM_KEY
notepad .env
# 2. 启动
npm start
```

改完 `.env` 后自测：

```bash
# 应返回 402 + PAYMENT-REQUIRED 头
curl -i -X POST http://localhost:3000/v1/vision/describe \
  -H "Content-Type: application/json" \
  -d "{\"image\":\"https://example.com/a.jpg\"}"
```

## 上游模型配置

`.env` 里的三个变量决定你卖的是什么能力：

| 变量 | 说明 |
|---|---|
| `UPSTREAM_BASE` | 任意 OpenAI 兼容端点。默认智谱 `https://open.bigmodel.cn/api/paas/v4`；硅基流动填 `https://api.siliconflow.cn/v1` |
| `UPSTREAM_KEY` | 该平台的 API Key |
| `VISION_MODEL` | 视觉模型名，默认 `glm-4.6v-flash` |

换模型即可切换成别的商品，不用动代码。

## 部署（任选其一）

| 方式 | 说明 | 公网地址 |
|---|---|---|
| Cloudflare Tunnel | 本机跑服务，隧道映射出去，免费、最快 | `xxx.trycloudflare.com` |
| VPS（阿里云/腾讯云国际站/Racknerd） | 最稳，长期挂机首选 | 自己的域名或 IP |
| Vercel / Railway / Fly.io | 支持 Node，push 即部署 | 平台子域名 |

### 方案 A：Cloudflare 临时隧道（已实测通过）

```powershell
# 一次性下载 cloudflared
Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile cloudflared.exe

# 应用服务（一个窗口）
cd output/x402-paywall
npm start

# 隧道（另一个窗口）
.\cloudflared.exe tunnel --url http://localhost:3000 --no-autoupdate
```

启动后 cloudflared 会打印形如 `https://instrumental-eds-spray-thermal.trycloudflare.com` 的地址。实测该地址从公网访问：
- `GET /health` → `200 {"ok":true}`
- `POST /v1/vision/describe`（未付费）→ `402`，响应头带 `payment-required`，`CF-Ray` 确认经 Cloudflare 边缘

**⚠️ 临时隧道的致命限制：每次重启 cloudflared，子域名都会变。**
这意味着它可以用来今天验证链路，但**不能用于上架审核**——审核期间平台会持续健康检查，域名一变就会被判死链、直接下架。

上架前必须换成固定地址，二选一：
1. `cloudflared tunnel create` 建具名隧道 + 绑定自己的域名（需把域名 NS 托管到 Cloudflare，免费）
2. 直接用境外 VPS，绑域名或固定 IP

⚠️ 国内服务器绑域名对外提供 API 收费服务涉及备案与跨境收付合规，自行评估。用 Cloudflare Tunnel + 境外 VPS 阻力最小。

## 上架到 Agent Marketplace（获取曝光）

上架后你的服务会出现在两处：
- 目录页：https://agents.circle.com/services
- Discovery API：`https://api.circle.com/v2/x402/discovery/resources`（公开无鉴权，Agent 靠它找你）

### 前置条件（缺一不可）

1. 端点已可付费：未付费请求返回 402 —— 本项目已满足
2. 已发布 OpenAPI 规格：本项目已含 `openapi.json`，把里面 `https://YOUR-DOMAIN-HERE` 换成你的实际域名
3. 收款钱包地址已确认 —— 审核时会对该地址做制裁名单筛查

### 提交

- 提交入口：https://forms.gle/7YFzvdmMcn1JH5tF6
- 需填：端点 URL、收款钱包地址、简短服务描述
- **人工审核**，目前无自助通道
- 通过后会被持续健康检查，端点不可达就会被下架（所以 `/health` 必须一直在）

## 收款查询

Gateway 收款会先累积在你的 Gateway 余额里，再批量结算上链。

```javascript
import { GatewayClient } from '@circle-fin/x402-batching/client';
// 查询与提现见官方文档：
// https://developers.circle.com/gateway-nanopayments/quickstarts/seller
```

每笔成功收费都会写入 `paid-calls.log`，用于对账。

## 定价参考（来自 2740 个在售服务的实测数据）

| 分位 | 单次价格 |
|---|---|
| 中位数 | $0.10 |
| 均值 | $0.447 |
| 最常见区间 | $0.10–0.50（占 75%） |
| 低价区 | <$0.01（2,206 条） |
| 高价区 | ≥$5（519 条，多为链上情报类） |

## 风险与边界

- **转售上游免费额度可能违反上游服务条款**。智谱/硅基流动的免费档是给你自己用的，不保证可用于商业转售。规模化前请先读其条款，或改用付费档。
- **免费额度有速率与总量限制**，被打爆会导致付费用户拿到 502。上线前务必做限流与降级。
- 收到的是 USDC（稳定币），不是法币。提现到银行卡需自行走合规通道。
- 本项目未做鉴权、限流、防滥用；对外暴露前建议加 IP 级限流。
*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
