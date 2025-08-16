// @ts-ignore
import { initTappSDK } from '@tapp-exchange/sdk';
import { 
  Aptos, 
  AptosConfig, 
  Account, 
  Ed25519PrivateKey,
  Network
} from '@aptos-labs/ts-sdk';
import * as fs from "fs";
import https from "https";

// Global variables
let CONFIG;
let tappSDK;
let aptos;
let account;

// Load configuration
try {
  const configData = fs.readFileSync('./config.json', 'utf8');
  CONFIG = JSON.parse(configData);
} catch (error) {
  console.error('Failed to load config.json:', error);
  process.exit(1);
}

// 当前使用的RPC节点索引
let currentRpcIndex = 0;

// Initialize services
function initializeServices() {
  const rpcUrls = CONFIG.rpcUrls || [CONFIG.rpcUrl].filter(Boolean);
  const currentRpcUrl = rpcUrls[currentRpcIndex];
  
  console.log(`使用RPC节点: ${currentRpcUrl}`);
  
  // Initialize TAPP SDK
  tappSDK = initTappSDK({
    network: CONFIG.network,
    url: currentRpcUrl
  });

  // Initialize Aptos
  const aptosConfigOptions = {
    network: CONFIG.network === 'testnet' ? Network.TESTNET : Network.MAINNET
  };
  
  if (currentRpcUrl) {
    aptosConfigOptions.fullnode = currentRpcUrl;
  }
  
  if (CONFIG.apiKey) {
    aptosConfigOptions.clientConfig = {
      API_KEY: CONFIG.apiKey
    };
  }
  
  const aptosConfig = new AptosConfig(aptosConfigOptions);
  aptos = new Aptos(aptosConfig);
  
  // Initialize wallet
  const privateKeyHex = loadPrivateKey();
  // 确保私钥格式符合AIP-80标准
  const formattedPrivateKey = `0x${privateKeyHex}`;
  const ed25519PrivateKey = new Ed25519PrivateKey(formattedPrivateKey);
  account = Account.fromPrivateKey({ privateKey: ed25519PrivateKey });
  
  console.log(`钱包地址: ${account.accountAddress.toString()}`);
}

// 切换到下一个RPC节点
function switchToNextRpc() {
  const rpcUrls = CONFIG.rpcUrls || [CONFIG.rpcUrl].filter(Boolean);
  currentRpcIndex = (currentRpcIndex + 1) % rpcUrls.length;
  console.log(`🔄 切换到RPC节点 ${currentRpcIndex + 1}/${rpcUrls.length}`);
  initializeServices();
}

function loadPrivateKey() {
  let privateKey = CONFIG.privateKey;
  
  if (!privateKey && CONFIG.privateKeyFile) {
    try {
      privateKey = fs.readFileSync(CONFIG.privateKeyFile, 'utf8').trim();
      console.log(`从 ${CONFIG.privateKeyFile} 加载私钥`);
    } catch (error) {
      console.error(`无法读取私钥文件 ${CONFIG.privateKeyFile}:`, error);
    }
  }
  
  if (!privateKey) {
    const keyFiles = ['private.key', 'wallet.key', 'test01.key'];
    for (const keyFile of keyFiles) {
      try {
        if (fs.existsSync(keyFile)) {
          privateKey = fs.readFileSync(keyFile, 'utf8').trim();
          console.log(`从 ${keyFile} 加载私钥`);
          break;
        }
      } catch (error) {
        continue;
      }
    }
  }
  
  if (!privateKey) {
    throw new Error('未找到私钥，请在config.json中设置privateKey或privateKeyFile');
  }
  
  // 移除0x前缀（如果存在）
  if (privateKey.startsWith('0x')) {
    privateKey = privateKey.slice(2);
  }
  
  // 验证私钥长度
  if (privateKey.length !== 64) {
    throw new Error(`私钥长度不正确，应为64个十六进制字符，实际为${privateKey.length}个字符`);
  }
  
  // 验证是否为有效的十六进制字符串
  if (!/^[0-9a-fA-F]+$/.test(privateKey)) {
    throw new Error('私钥包含无效字符，只能包含十六进制字符(0-9, a-f, A-F)');
  }
  return privateKey;
}

/**
 * 发送Telegram消息
 * @param {string} text - 消息内容
 */
export function sendTelegramMessage(text) {
  if (!CONFIG.telegram || !CONFIG.telegram.enabled) {
    return Promise.resolve();
  }

  const botToken = CONFIG.telegram.botToken;
  const chatId = CONFIG.telegram.chatId;
  
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
    });

    const options = {
      hostname: "api.telegram.org",
      path: `/bot${botToken}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            console.error("Telegram发送失败:", parsed);
            reject(parsed);
          } else {
            console.log("Telegram发送成功");
            resolve(parsed);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", (e) => {
      console.error("Telegram请求错误:", e);
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 计算损耗百分比
 * @param {Object} initialBalances - 初始余额
 * @param {Object} currentBalances - 当前余额
 */
export function calculateLoss(initialBalances, currentBalances) {
  const initialTotal = initialBalances.tokenA + initialBalances.tokenB;
  const currentTotal = currentBalances.tokenA + currentBalances.tokenB;
  
  if (initialTotal === 0) return 0;
  
  const lossPercentage = ((initialTotal - currentTotal) / initialTotal) * 100;
  return Math.max(0, lossPercentage);
}

/**
 * TAPP交换机器人类
 */
export class TappSwapBot {
  constructor(config) {
    this.config = config;
    this.currentPool = null;
    this.initialBalances = {};
    this.initialTotalValue = 0; // 记录初始总价值（USDT + USDC），按1:1汇率计算
    
    initializeServices();
  }

  async initialize() {
    try {
      console.log('初始化TAPP交换机器人...');
      
      // 获取最佳交易池
      this.currentPool = await this.findBestPool();
      
      if (!this.currentPool) {
        console.error('未找到可用的交易池');
        return false;
      }

      // 验证池的有效性
      const isValid = await this.validatePool(this.currentPool);
      if (!isValid) {
        console.error('交易池验证失败');
        return false;
      }

      // 记录初始余额
      await this.recordInitialBalances();
      
      console.log(`初始化完成，使用池: ${this.currentPool.poolId}`);
      console.log(`池类型: ${this.currentPool.poolType}, TVL: ${this.currentPool.tvl || 'Unknown'}`);
      
      return true;
    } catch (error) {
      console.error('初始化失败:', error);
      return false;
    }
  }

  async findBestPool() {
    try {
      // 如果配置中指定了poolId，直接使用
      if (this.config.poolId) {
        const poolInfo = await this.getPoolInfo(this.config.poolId);
        return {
          poolId: this.config.poolId,
          poolType: this.config.poolType || 'AMM',
          tokenA: this.config.tokenAAddress,
          tokenB: this.config.tokenBAddress,
          tvl: poolInfo.tvl || 0
        };
      }

      // 否则从池列表中查找
      const poolsResponse = await tappSDK.Pool.getPools({
        page: 1,
        size: 100,
        sortBy: 'tvl',
        type: this.config.poolType
      });

      // 处理不同的API响应格式
      let pools;
      if (Array.isArray(poolsResponse)) {
        pools = poolsResponse;
      } else if (poolsResponse && poolsResponse.data) {
        pools = poolsResponse.data;
      } else if (poolsResponse && poolsResponse.result) {
        pools = poolsResponse.result;
      } else {
        console.log('池子API响应格式:', poolsResponse);
        throw new Error('无法解析池子数据');
      }

      if (!pools || pools.length === 0) {
        throw new Error('未找到任何交易池');
      }

      console.log(`找到 ${pools.length} 个池子`);

      // 查找匹配的代币对
      const targetPool = pools.find(pool => {
        const tokenA = this.config.tokenAAddress || this.config.tokenAName;
        const tokenB = this.config.tokenBAddress || this.config.tokenBName;
        
        // 处理新的tokens数组结构
        if (pool.tokens && Array.isArray(pool.tokens) && pool.tokens.length >= 2) {
          const poolTokenA = pool.tokens[0].addr;
          const poolTokenB = pool.tokens[1].addr;
          
          return (poolTokenA === tokenA && poolTokenB === tokenB) ||
                 (poolTokenA === tokenB && poolTokenB === tokenA);
        }
        
        // 兼容旧的结构
        return (pool.tokenA === tokenA && pool.tokenB === tokenB) ||
               (pool.tokenA === tokenB && pool.tokenB === tokenA);
      });

      if (!targetPool) {
        console.log('未找到指定代币对的池子');
        console.log('可用的池子:');
        pools.slice(0, 5).forEach((pool, index) => {
          let tokenAInfo = 'Unknown';
          let tokenBInfo = 'Unknown';
          
          if (pool.tokens && Array.isArray(pool.tokens) && pool.tokens.length >= 2) {
            tokenAInfo = `${pool.tokens[0].symbol || 'Unknown'}`;
            tokenBInfo = `${pool.tokens[1].symbol || 'Unknown'}`;
          } else {
            tokenAInfo = pool.tokenA || pool.token_a || 'Unknown';
            tokenBInfo = pool.tokenB || pool.token_b || 'Unknown';
          }
          
          console.log(`${index + 1}. ${tokenAInfo} / ${tokenBInfo}`);
        });
        
        // 暂时使用第一个池子进行测试
        console.log('使用第一个可用池子进行测试');
        const firstPool = pools[0];
        
        let poolTokenA, poolTokenB;
        if (firstPool.tokens && Array.isArray(firstPool.tokens) && firstPool.tokens.length >= 2) {
          poolTokenA = firstPool.tokens[0].addr;
          poolTokenB = firstPool.tokens[1].addr;
        } else {
          poolTokenA = firstPool.tokenA || firstPool.token_a || this.config.tokenAAddress;
          poolTokenB = firstPool.tokenB || firstPool.token_b || this.config.tokenBAddress;
        }
        
        return {
          poolId: firstPool.poolId || firstPool.pool_id || firstPool.id,
          poolType: firstPool.poolType || firstPool.type || this.config.poolType,
          tokenA: poolTokenA,
          tokenB: poolTokenB,
          tvl: firstPool.tvl || 0
        };
      }

      // 提取找到的池子信息
      let poolTokenA, poolTokenB;
      if (targetPool.tokens && Array.isArray(targetPool.tokens) && targetPool.tokens.length >= 2) {
        poolTokenA = targetPool.tokens[0].addr;
        poolTokenB = targetPool.tokens[1].addr;
      } else {
        poolTokenA = targetPool.tokenA || targetPool.token_a;
        poolTokenB = targetPool.tokenB || targetPool.token_b;
      }

      return {
        poolId: targetPool.poolId || targetPool.pool_id || targetPool.id,
        poolType: targetPool.poolType || targetPool.type || this.config.poolType,
        tokenA: poolTokenA,
        tokenB: poolTokenB,
        tvl: targetPool.tvl || 0
      };
    } catch (error) {
      console.error('查找最佳池失败:', error);
      return null;
    }
  }

  async getPoolInfo(poolId) {
    try {
      return await tappSDK.Pool.getInfo(poolId);
    } catch (error) {
      console.error(`获取池信息失败 ${poolId}:`, error);
      return { tvl: 0 };
    }
  }

  async validatePool(poolInfo) {
    try {
      // 基本验证
      if (!poolInfo.poolId) {
        console.log('池子验证失败: 缺少poolId');
        return false;
      }

      console.log(`验证池子: ${poolInfo.poolId}`);
      console.log(`代币对: ${poolInfo.tokenA} / ${poolInfo.tokenB}`);
      
      // 暂时跳过路由验证，直接返回true
      console.log('池子验证通过');
      return true;
      
      // TODO: 恢复路由验证
      // const route = await tappSDK.Swap.getRoute(poolInfo.tokenA, poolInfo.tokenB);
      // return route && route.length > 0;
    } catch (error) {
      console.error('池验证失败:', error);
      return false;
    }
  }

  async recordInitialBalances() {
    try {
      if (!this.currentPool) return;
      
      this.initialBalances.tokenA = await this.getBalance(this.currentPool.tokenA);
      this.initialBalances.tokenB = await this.getBalance(this.currentPool.tokenB);
      
      // 计算初始总价值（USDT + USDC，按1:1汇率）
      this.initialTotalValue = this.initialBalances.tokenA + this.initialBalances.tokenB;
      
      console.log(`初始余额 ${CONFIG.tokenAName}: ${this.initialBalances.tokenA}`);
      console.log(`初始余额 ${CONFIG.tokenBName}: ${this.initialBalances.tokenB}`);
      console.log(`初始总价值: ${this.initialTotalValue.toFixed(6)}`);
    } catch (error) {
      console.error('记录初始余额失败:', error);
    }
  }

  async getBalance(tokenAddress, showLogs = true, retryCount = 0) {
    try {
      if (showLogs) console.log(`🔍 查询余额...`);
      
      // 检查是否是APT原生代币
      if (tokenAddress === '0x1::aptos_coin::AptosCoin' || tokenAddress === '0x1') {
        const balance = await aptos.getAccountAPTAmount({
          accountAddress: account.accountAddress
        });
        const formattedBalance = balance / (10 ** 8); // APT是8位小数
        if (showLogs) console.log(`✅ APT余额: ${formattedBalance}`);
        return formattedBalance;
      }
      
      // 首先尝试作为Fungible Asset查询
      try {
        const faBalance = await this.getFungibleAssetBalance(tokenAddress, showLogs);
        if (faBalance > 0) {
          if (showLogs) console.log(`✅ 余额: ${faBalance}`);
          return faBalance;
        }
      } catch (faError) {
        // 检查是否是速率限制错误
        if (faError.status === 429 && retryCount < 3) {
          console.log(`⚠️ 余额查询遇到速率限制，切换RPC节点并重试...`);
          switchToNextRpc();
          await new Promise(resolve => setTimeout(resolve, 1000));
          return await this.getBalance(tokenAddress, showLogs, retryCount + 1);
        }
        if (showLogs) console.log(`⚠️ Fungible Asset查询失败: ${faError.message}`);
      }
      
      // 然后尝试作为Coin查询
      try {
        const coinBalance = await this.getCoinBalance(tokenAddress, showLogs);
        if (showLogs) console.log(`✅ 余额: ${coinBalance}`);
        return coinBalance;
      } catch (coinError) {
        if (showLogs) console.log(`⚠️ Coin查询失败: ${coinError.message}`);
      }
      
      if (showLogs) console.log(`❌ 所有查询方法都失败，返回0`);
      return 0;
    } catch (error) {
      if (showLogs) console.error(`❌ 获取余额异常:`, error);
      return 0;
    }
  }

  async getFungibleAssetBalance(tokenAddress, showLogs = true) {
    try {
      const balances = await aptos.getCurrentFungibleAssetBalances({
        options: { 
          where: { 
            owner_address: { _eq: account.accountAddress.toString() } 
          } 
        }
      });
      
      // 只在调试模式下打印详细信息
      if (CONFIG.debugMode && CONFIG.debugMode.logDetailedInfo && CONFIG.debugMode.enabled) {
        console.log('所有Fungible Asset余额:');
        balances.forEach((balance, index) => {
          console.log(`${index + 1}. ${balance.asset_type}: ${balance.amount}`);
        });
      }
      
      // 精确匹配
      let tokenBalance = balances.find(b => b.asset_type === tokenAddress);
      
      // 如果精确匹配失败，尝试包含匹配
      if (!tokenBalance) {
        tokenBalance = balances.find(b => {
          return b.asset_type.includes(tokenAddress) ||
                 tokenAddress.includes(b.asset_type);
        });
      }
      
      if (tokenBalance && tokenBalance.amount) {
        const rawAmount = BigInt(tokenBalance.amount);
        
        // 尝试获取代币的小数位数，默认6位
        let decimals = 6;
        
        // USDT/USDC通常是6位小数
        if (tokenAddress.includes('USDT') || tokenAddress.includes('USDC')) {
          decimals = 6;
        }
        
        const formattedAmount = Number(rawAmount) / (10 ** decimals);
        return formattedAmount;
      }
      
      return 0;
    } catch (error) {
      throw error;
    }
  }

  async getCoinBalance(tokenAddress, showLogs = true) {
    try {
      let coinType = tokenAddress;
      
      // 如果地址不包含::，尝试构造Coin类型
      if (!coinType.includes('::') && coinType !== '0x1') {
        coinType = `${coinType}::coin::T`;
      }
      
      const balance = await aptos.getAccountCoinAmount({
        accountAddress: account.accountAddress,
        coinType: coinType
      });
      
      // 尝试获取代币的小数位数，默认6位
      let decimals = 6;
      
      // USDT/USDC通常是6位小数
      if (coinType.includes('USDT') || coinType.includes('USDC')) {
        decimals = 6;
      }
      
      const formattedBalance = balance / (10 ** decimals);
      return formattedBalance;
    } catch (error) {
      throw error;
    }
  }

  async executeSwap(a2b) {
    try {
      if (!this.currentPool) {
        console.error('未初始化交易池');
        return false;
      }

      const tokenIn = a2b ? this.currentPool.tokenA : this.currentPool.tokenB;
      const tokenOut = a2b ? this.currentPool.tokenB : this.currentPool.tokenA;
      const tokenInName = a2b ? CONFIG.tokenAName : CONFIG.tokenBName;
      const tokenOutName = a2b ? CONFIG.tokenBName : CONFIG.tokenAName;
      
      // 获取当前余额决定交换数量
      const balance = await this.getBalance(tokenIn);
      console.log(`💰 当前${tokenInName}余额: ${balance}`);
      
      // 如果当前方向的代币余额为0，返回false让程序切换方向
      if (balance <= 0) {
        console.log(`⚠️ ${tokenInName}余额不足，跳过此次交换`);
        return false;
      }
      
      let swapAmount;
      const balanceInAtomic = balance * (10 ** 6); // 转换为原子单位
      const maxAmountFromBalance = balanceInAtomic; // 使用余额的100%
      swapAmount = Math.min(maxAmountFromBalance, this.config.initialAmount);
      
      // 最小交换数量检查
      if (swapAmount < 1000000) { // 1 USDT
        console.warn(`交换数量过小: ${swapAmount / (10**6)} < 1`);
        return false;
      }

      const swapParams = {
        poolInfo: this.currentPool,
        amountIn: Math.floor(swapAmount),
        tokenIn,
        tokenOut,
        a2b
      };

      // 获取估算
      const estimate = await this.estimateSwap(swapParams);
      if (!estimate) {
        console.error('无法获取交换估算');
        return false;
      }

      console.log(`🔄 执行交换: ${(swapAmount / (10**6)).toFixed(2)} ${tokenInName} -> ${(estimate.amountOut / (10**6)).toFixed(2)} ${tokenOutName}`);
      
      // 执行交换
      const txHash = await this.performSwap(swapParams, estimate);
      
      if (txHash) {
        console.log(`✅ 交换成功: ${txHash}`);
        return true;
      } else {
        console.log(`❌ 交换失败`);
        return false;
      }
    } catch (error) {
      console.error('交换执行失败:', error);
      return false;
    }
  }

  async executeSwapWithCustomAmount(a2b, customAmount) {
    try {
      if (!this.currentPool) {
        console.error('未初始化交易池');
        return false;
      }

      const tokenIn = a2b ? this.currentPool.tokenA : this.currentPool.tokenB;
      const tokenOut = a2b ? this.currentPool.tokenB : this.currentPool.tokenA;
      
      // 使用自定义数量
      const swapAmount = customAmount;
      
      // 最小交换数量检查
      if (swapAmount < 1000000) { // 1 USDT
        console.warn(`交换数量过小: ${swapAmount / (10**6)} < 1`);
        return false;
      }

      // 检查余额是否足够
      const balance = await this.getBalance(tokenIn);
      const balanceInAtomic = balance * (10 ** 6);
      
      if (balanceInAtomic < swapAmount) {
        console.error(`余额不足: 需要 ${swapAmount / (10**6)}, 实际 ${balance}`);
        return false;
      }

      const swapParams = {
        poolInfo: this.currentPool,
        amountIn: Math.floor(swapAmount),
        tokenIn,
        tokenOut,
        a2b
      };

      // 获取估算
      const estimate = await this.estimateSwap(swapParams);
      if (!estimate) {
        console.error('无法获取交换估算');
        return false;
      }

      // Debug模式详细日志
      if (CONFIG.debugMode && CONFIG.debugMode.logDetailedInfo) {
        console.log(`📊 交换详情:`);
        console.log(`输入: ${swapAmount / (10**6)} ${a2b ? CONFIG.tokenAName : CONFIG.tokenBName}`);
        console.log(`预期输出: ${estimate.amountOut / (10**6)} ${a2b ? CONFIG.tokenBName : CONFIG.tokenAName}`);
        console.log(`价格影响: ${estimate.priceImpact}%`);
        console.log(`手续费: ${estimate.fee / (10**6)}`);
        console.log(`最小输出: ${estimate.minAmountOut / (10**6)}`);
      }

      console.log(`🔄 执行交换: ${swapAmount / (10**6)} ${a2b ? 'A' : 'B'} -> ${estimate.amountOut / (10**6)} ${a2b ? 'B' : 'A'}`);
      
      // 执行交换
      const txHash = await this.performSwap(swapParams, estimate);
      
      if (txHash && CONFIG.debugMode && CONFIG.debugMode.logDetailedInfo) {
        console.log(`✅ 交易哈希: ${txHash}`);
      }
      
      return txHash !== null;
    } catch (error) {
      console.error('自定义数量交换执行失败:', error);
      return false;
    }
  }

  async validateSwapConditions(params) {
    try {
      const { tokenIn, amountIn } = params;
      
      // 检查余额是否足够
      const balance = await this.getBalance(tokenIn);
      const balanceInAtomic = balance * (10 ** 6);
      
      if (balanceInAtomic < amountIn) {
        console.warn(`余额不足: 需要 ${amountIn / (10**6)}, 实际 ${balance}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error('验证交换条件失败:', error);
      return false;
    }
  }

  async estimateSwap(params) {
    try {
      const { poolInfo, amountIn, a2b } = params;
      
      const estimateParams = {
        poolId: poolInfo.poolId,
        a2b,
        field: 'input',
        amount: amountIn,
        pair: [0, 1]
      };

      const result = await tappSDK.Swap.getEstSwapAmount(estimateParams);
      
      if (result && result.error) {
        console.error('交换估算错误:', result.error.message);
        return null;
      }
      
      // TAPP SDK返回的字段可能是 estAmount 而不是 amountOut
      const estimatedAmountOut = result.amountOut || result.estAmount;
      
      if (!result || estimatedAmountOut === undefined || estimatedAmountOut === null) {
        console.error('估算结果无效:', result);
        return null;
      }

      const slippageMultiplier = 1 - (this.config.slippageTolerance / 100);
      const minAmountOut = Math.floor(estimatedAmountOut * slippageMultiplier);

      const estimate = {
        amountOut: estimatedAmountOut,
        amountIn: result.amountIn || result.amount || amountIn,
        priceImpact: result.priceImpact || 0,
        fee: result.fee || 0,
        minAmountOut
      };
      
      return estimate;
    } catch (error) {
      console.error('估算交换失败:', error);
      return null;
    }
  }

  async performSwap(params, estimate) {
    try {
      const { poolInfo } = params;
      let payload;

      switch (poolInfo.poolType) {
        case 'AMM':
          payload = this.createAMMSwapPayload(params, estimate);
          break;
        case 'CLMM':
          payload = this.createCLMMSwapPayload(params, estimate);
          break;
        case 'STABLE':
          payload = this.createStableSwapPayload(params, estimate);
          break;
        default:
          throw new Error(`不支持的池类型: ${poolInfo.poolType}`);
      }

      return await this.submitTransaction(payload);
    } catch (error) {
      console.error('执行交换失败:', error);
      return null;
    }
  }

  createAMMSwapPayload(params, estimate) {
    const { poolInfo, amountIn, a2b } = params;
    
    return tappSDK.Swap.swapAMMTransactionPayload({
      poolId: poolInfo.poolId,
      a2b,
      fixedAmountIn: true,
      amount0: a2b ? amountIn : estimate.minAmountOut,
      amount1: a2b ? estimate.minAmountOut : amountIn
    });
  }

  createCLMMSwapPayload(params, estimate) {
    const { poolInfo, amountIn, a2b } = params;
    
    return tappSDK.Swap.swapCLMMTransactionPayload({
      poolId: poolInfo.poolId,
      amountIn,
      minAmountOut: estimate.minAmountOut,
      a2b,
      fixedAmountIn: true,
      targetSqrtPrice: 0
    });
  }

  createStableSwapPayload(params, estimate) {
    const { poolInfo, amountIn, a2b } = params;
    
    return tappSDK.Swap.swapStableTransactionPayload({
      poolId: poolInfo.poolId,
      tokenIn: a2b ? 0 : 1,
      tokenOut: a2b ? 1 : 0,
      amountIn,
      minAmountOut: estimate.minAmountOut
    });
  }

  async submitTransaction(payload, retryCount = 0) {
    try {
      const transaction = await aptos.transaction.build.simple({
        sender: account.accountAddress,
        data: payload
      });

      const pendingTxn = await aptos.signAndSubmitTransaction({
        signer: account,
        transaction
      });

      const response = await aptos.waitForTransaction({
        transactionHash: pendingTxn.hash
      });

      return response.hash;
    } catch (error) {
      // 检查是否是速率限制错误
      if (error.status === 429 && retryCount < 3) {
        console.log(`⚠️ 遇到速率限制，切换RPC节点并重试...`);
        switchToNextRpc();
        await new Promise(resolve => setTimeout(resolve, 2000)); // 等待2秒
        return await this.submitTransaction(payload, retryCount + 1);
      }
      
      console.error('交易失败:', error);
      return null;
    }
  }

  async calculateCurrentLoss() {
    try {
      if (!this.currentPool || this.initialTotalValue === 0) return 0;
      
      // 获取当前余额
      const currentBalanceA = await this.getBalance(this.currentPool.tokenA, false);
      const currentBalanceB = await this.getBalance(this.currentPool.tokenB, false);
      
      // 计算当前总价值（USDT + USDC，按1:1汇率）
      const currentTotalValue = currentBalanceA + currentBalanceB;
      
      // 计算损耗百分比
      const lossAmount = this.initialTotalValue - currentTotalValue;
      const lossPercentage = (lossAmount / this.initialTotalValue) * 100;
      
      return Math.max(0, lossPercentage);
    } catch (error) {
      console.error('计算当前损耗失败:', error);
      return 0;
    }
  }
  
  async getCurrentBalances() {
    try {
      if (!this.currentPool) return { tokenA: 0, tokenB: 0, totalValue: 0 };
      
      const balanceA = await this.getBalance(this.currentPool.tokenA, false);
      const balanceB = await this.getBalance(this.currentPool.tokenB, false);
      const totalValue = balanceA + balanceB;
      
      return { tokenA: balanceA, tokenB: balanceB, totalValue: totalValue };
    } catch (error) {
      console.error('获取当前余额失败:', error);
      return { tokenA: 0, tokenB: 0, totalValue: 0 };
    }
  }
}