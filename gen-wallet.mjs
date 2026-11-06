/**
 * 生成一个全新的 EVM 收款钱包
 * - 私钥直接写入备份文件，不打印到控制台
 * - 自动把地址写进 .env 的 SELLER_ADDRESS
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const envPath = path.join(here, '.env');
const secretPath = path.join(here, '.wallet-backup.txt');

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

// 1) 私钥落盘（仅本机，供导入钱包使用）
const backup = `=== x402 收款钱包备份 · 导入钱包后请立即删除本文件 ===

地址 (Address):
${account.address}

私钥 (Private Key):
${privateKey}

生成时间: ${new Date().toISOString()}

【怎么用】
1. 打开 OKX App -> 底部 Web3 -> 钱包管理 -> 导入钱包 -> 私钥导入
   或 MetaMask -> 导入账户 -> 粘贴私钥
2. 导入成功后，立刻把本文件从磁盘删除（并清空回收站）
3. 该地址对所有 EVM 链通用：Ethereum / Base / Polygon / Arbitrum / Optimism / Avalanche 等

【警告】
- 任何人拿到上面的私钥，就能转走这个地址里的全部资金
- 不要截图、不要发微信、不要存到网盘或备忘录
- 这个文件只应该存在于你现在这台电脑上，且尽快消失
`;
fs.writeFileSync(secretPath, backup, { encoding: 'utf8', mode: 0o600 });

// 2) 更新 .env
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
if (/^SELLER_ADDRESS=.*$/m.test(env)) {
  env = env.replace(/^SELLER_ADDRESS=.*$/m, `SELLER_ADDRESS=${account.address}`);
} else {
  env += `\nSELLER_ADDRESS=${account.address}\n`;
}
fs.writeFileSync(envPath, env, 'utf8');

// 3) 只输出地址
console.log('ADDRESS=' + account.address);
console.log('SECRET_FILE=' + secretPath);
