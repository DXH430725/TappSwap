import { 
    TappSwapBot,
    sendTelegramMessage,
    delay 
} from "./modules.js";
import * as fs from "fs";

// Load configuration
let CONFIG;
try {
  const configData = fs.readFileSync('./config.json', 'utf8');
  CONFIG = JSON.parse(configData);
} catch (error) {
  console.error('Failed to load config.json:', error);
  process.exit(1);
}

// Statistics tracking
let statistics = {
  totalSwaps: 0,
  successfulSwaps: 0,
  failedSwaps: 0,
  totalFees: 0,
  currentLoss: 0,
  startTime: new Date(),
  isRunning: false
};

function tele(message) {
  if (CONFIG.telegram && CONFIG.telegram.enabled) {
    sendTelegramMessage(message);
  }
}

function printWelcome() {
  console.clear();
  console.log('🚀 TAPP DEX 自动刷量程序');
  console.log('═'.repeat(60));
  console.log('官方激励活动参与工具');
  console.log('通过自动交换获得积分奖励');
  console.log('版本: 1.0.0');
  console.log('═'.repeat(60));
  console.log();
  
  console.log('⚠️  重要提醒:');
  console.log('• 请确保钱包中有足够的 APT 作为 Gas 费');
  console.log('• 建议在交易量较低时段使用，减少失败率');
  console.log('• 程序会在达到指定损耗后自动停止');
  console.log('• 支持随时按 Ctrl+C 安全停止');
  console.log();
}

function showConfiguration() {
  console.log('📋 当前配置:');
  console.log(`网络: ${CONFIG.network}`);
  console.log(`交易对: ${CONFIG.tokenAName || 'Token A'} ⇄ ${CONFIG.tokenBName || 'Token B'}`);
  
  if (CONFIG.debugMode && CONFIG.debugMode.enabled) {
    console.log('🔧 调试模式: 启用');
    console.log(`测试数量: ${CONFIG.debugMode.testAmount / (10**6)} ${CONFIG.tokenAName || 'Token A'}`);
    console.log(`往返交易: ${CONFIG.debugMode.singleRoundTrip ? '单次' : '连续'}`);
    console.log(`交换间隔: ${CONFIG.debugMode.delayBetweenSwaps}ms`);
  } else {
    console.log('🔄 生产模式: 启用');
    console.log(`最大交换量: ${CONFIG.initialAmount} (最小单位)`);
    console.log(`最大损耗: ${CONFIG.maxLossPercentage}%`);
    console.log(`延迟范围: ${CONFIG.delayMinMs}-${CONFIG.delayMaxMs}ms`);
  }
  
  console.log(`滑点容忍: ${CONFIG.slippageTolerance}%`);
  console.log();
}

function printStatistics() {
  const runtime = Date.now() - statistics.startTime.getTime();
  const runtimeMinutes = Math.floor(runtime / 60000);
  
  console.log('📊 交换统计:');
  console.log(`运行时间: ${runtimeMinutes} 分钟`);
  console.log(`总交换次数: ${statistics.totalSwaps}`);
  console.log(`成功交换: ${statistics.successfulSwaps}`);
  console.log(`失败交换: ${statistics.failedSwaps}`);
  if (statistics.totalSwaps > 0) {
    console.log(`成功率: ${((statistics.successfulSwaps / statistics.totalSwaps) * 100).toFixed(2)}%`);
  }
  console.log(`总手续费: ${statistics.totalFees}`);
  console.log(`最终损耗: ${statistics.currentLoss.toFixed(4)}%`);
}

async function main() {
  printWelcome();
  showConfiguration();
  
  // 初始化机器人
  console.log('═'.repeat(60));
  console.log('初始化机器人...');
  
  const bot = new TappSwapBot(CONFIG);
  const initialized = await bot.initialize();
  
  if (!initialized) {
    console.error('机器人初始化失败，程序退出');
    tele('🚫 机器人初始化失败，程序退出');
    return;
  }
  
  // 设置信号处理
  setupSignalHandlers(bot);
  
  // 检查是否为调试模式
  if (CONFIG.debugMode && CONFIG.debugMode.enabled) {
    await runDebugMode(bot);
  } else {
    await runProductionMode(bot);
  }
}

async function runDebugMode(bot) {
  console.log('═'.repeat(60));
  console.log('🔧 启动调试模式...');
  tele(`🔧 TAPP调试模式启动\n交易对: ${CONFIG.tokenAName || 'Token A'} ⇄ ${CONFIG.tokenBName || 'Token B'}\n测试数量: ${CONFIG.debugMode.testAmount / (10**6)}`);
  
  statistics.isRunning = true;
  statistics.startTime = new Date();
  
  try {
    // 记录初始余额
    const initialBalanceA = await bot.getBalance(bot.currentPool.tokenA);
    const initialBalanceB = await bot.getBalance(bot.currentPool.tokenB);
    
    console.log(`🏁 初始余额:`);
    console.log(`${CONFIG.tokenAName}: ${initialBalanceA}`);
    console.log(`${CONFIG.tokenBName}: ${initialBalanceB}`);
    console.log();
    
    // 第一步：A -> B
    console.log(`🔄 第1步: ${CONFIG.tokenAName} -> ${CONFIG.tokenBName}`);
    statistics.totalSwaps++;
    const success1 = await bot.executeSwapWithCustomAmount(true, CONFIG.debugMode.testAmount);
    
    if (success1) {
      statistics.successfulSwaps++;
      console.log(`✅ 第1步交换成功`);
      
      // 等待间隔
      console.log(`⏳ 等待 ${CONFIG.debugMode.delayBetweenSwaps}ms...`);
      await delay(CONFIG.debugMode.delayBetweenSwaps);
      
      // 检查中间余额
      if (CONFIG.debugMode.logDetailedInfo) {
        const midBalanceA = await bot.getBalance(bot.currentPool.tokenA);
        const midBalanceB = await bot.getBalance(bot.currentPool.tokenB);
        console.log(`📊 中间余额:`);
        console.log(`${CONFIG.tokenAName}: ${midBalanceA}`);
        console.log(`${CONFIG.tokenBName}: ${midBalanceB}`);
        console.log();
      }
      
      // 第二步：B -> A (往返)
      console.log(`🔄 第2步: ${CONFIG.tokenBName} -> ${CONFIG.tokenAName} (往返)`);
      statistics.totalSwaps++;
      const success2 = await bot.executeSwap(false); // 使用当前余额
      
      if (success2) {
        statistics.successfulSwaps++;
        console.log(`✅ 第2步交换成功`);
      } else {
        statistics.failedSwaps++;
        console.log(`❌ 第2步交换失败`);
      }
    } else {
      statistics.failedSwaps++;
      console.log(`❌ 第1步交换失败，跳过第2步`);
    }
    
    // 最终余额和损耗计算
    await delay(2000); // 等待区块确认
    const finalBalanceA = await bot.getBalance(bot.currentPool.tokenA);
    const finalBalanceB = await bot.getBalance(bot.currentPool.tokenB);
    
    console.log(`🏁 最终余额:`);
    console.log(`${CONFIG.tokenAName}: ${finalBalanceA}`);
    console.log(`${CONFIG.tokenBName}: ${finalBalanceB}`);
    
    const finalLoss = await bot.calculateCurrentLoss();
    statistics.currentLoss = finalLoss;
    
    console.log(`📊 往返交易损耗: ${finalLoss.toFixed(6)}%`);
    
    tele(`🔧 调试模式完成\n往返交易: ${statistics.successfulSwaps}/${statistics.totalSwaps}\n最终损耗: ${finalLoss.toFixed(6)}%`);
    
  } catch (error) {
    console.error('调试模式错误:', error);
    tele(`❌ 调试模式出错: ${error.message}`);
  }

  statistics.isRunning = false;
  console.log('🔧 调试模式完成');
  printStatistics();
}

async function runProductionMode(bot) {
  console.log('═'.repeat(60));
  console.log('🔄 启动生产模式...');
  tele(`🚀 TAPP自动交换程序启动\n交易对: ${CONFIG.tokenAName || 'Token A'} ⇄ ${CONFIG.tokenBName || 'Token B'}\n目标损耗阈值: ${CONFIG.maxLossPercentage}%`);
  
  statistics.isRunning = true;
  statistics.startTime = new Date();
  
  let currentDirection = true; // true: A->B, false: B->A
  let swapCount = 0;
  
  while (statistics.isRunning) {
    try {
      // 每5次交换检查一次损耗
      if (swapCount % 5 === 0 && swapCount > 0) {
        const currentLoss = await bot.calculateCurrentLoss();
        statistics.currentLoss = currentLoss;
        
        if (currentLoss >= CONFIG.maxLossPercentage) {
          console.log(`🛑 达到最大损耗阈值 ${CONFIG.maxLossPercentage}%，停止交换`);
          tele(`🛑 达到最大损耗阈值 ${CONFIG.maxLossPercentage}%，程序停止\n最终损耗: ${currentLoss.toFixed(4)}%`);
          break;
        }
        
        console.log(`当前损耗: ${currentLoss.toFixed(4)}%`);
      }

      // 执行交换
      statistics.totalSwaps++;
      const success = await bot.executeSwap(currentDirection);
      
      if (success) {
        statistics.successfulSwaps++;
        currentDirection = !currentDirection; // 切换方向
        swapCount++;
        
        // 获取当前余额和损耗
        const balances = await bot.getCurrentBalances();
        const currentLoss = await bot.calculateCurrentLoss();
        
        console.log(`💰 当前余额: ${CONFIG.tokenAName} ${balances.tokenA.toFixed(2)} | ${CONFIG.tokenBName} ${balances.tokenB.toFixed(2)}`);
        console.log(`📊 总价值: ${balances.totalValue.toFixed(6)} | 损耗: ${currentLoss.toFixed(4)}%`);
        
        if (statistics.totalSwaps % 10 === 0) {
          tele(`📊 已完成 ${statistics.totalSwaps} 次交换\n成功: ${statistics.successfulSwaps}\n失败: ${statistics.failedSwaps}\n当前损耗: ${currentLoss.toFixed(4)}%`);
        }
      } else {
        statistics.failedSwaps++;
        console.log(`❌ 交换失败，尝试切换方向`);
        currentDirection = !currentDirection; // 交换失败时也切换方向
      }

      // 随机延迟
      const delayMs = Math.floor(
        Math.random() * (CONFIG.delayMaxMs - CONFIG.delayMinMs) + CONFIG.delayMinMs
      );
      console.log(`⏳ 等待 ${delayMs}ms...`);
      await delay(delayMs);
      
    } catch (error) {
      console.error('交换周期错误:', error);
      tele(`⚠️ 交换出现错误: ${error.message}`);
      await delay(5000); // 错误时等待5秒
    }
  }

  statistics.isRunning = false;
  console.log('🛑 自动交换已停止');
  printStatistics();
  tele(`🏁 程序停止\n总交换: ${statistics.totalSwaps}\n成功率: ${statistics.totalSwaps > 0 ? ((statistics.successfulSwaps / statistics.totalSwaps) * 100).toFixed(2) : 0}%\n最终损耗: ${statistics.currentLoss.toFixed(4)}%`);
}

function setupSignalHandlers(bot) {
  const gracefulShutdown = () => {
    console.log();
    console.log('接收到退出信号，正在安全停止...');
    statistics.isRunning = false;
    
    setTimeout(() => {
      console.log('程序已安全退出');
      printStatistics();
      process.exit(0);
    }, 2000);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  process.on('uncaughtException', (error) => {
    console.error('未捕获的异常:', error);
    statistics.isRunning = false;
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的 Promise 拒绝:', { reason, promise });
    statistics.isRunning = false;
    process.exit(1);
  });
}

// 启动程序
main().catch(error => {
  console.error('启动失败:', error);
  process.exit(1);
});