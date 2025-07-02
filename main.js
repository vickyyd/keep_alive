// API配置列表
const API_CONFIGS = [
  {
    name: "", 
    apiName: "", 
    url: "", 
    apiKey: "" 
  },
];

// 全局配置
const CONFIG = {
  HISTORY_LIMIT: 50,
  CACHE_TTL: 300000, // 增加到5分钟，减少数据库查询
  MAX_RETRIES: 3,
  DEBUG_MODE: false, // 生产环境关闭调试日志
  QUESTIONS: [
    "Hi",
    "How are you", 
    "Ok",
  ]
};

// 调试日志函数
const debugLog = (...args) => {
  if (CONFIG.DEBUG_MODE) {
    console.log(...args);
  }
};

// 全局缓存和计数器
const CACHE = { 
  apiStats: null, 
  history: null, 
  cacheTime: 0,
  initialized: false  // 数据库初始化状态
};
let dbOperationsCount = 0;
let apiCallsCount = 0;

// 数据库操作模块
const Database = {
  async init(db) {
    // 如果已经初始化过，跳过
    if (CACHE.initialized) {
      return true;
    }
    
    dbOperationsCount++;
    try {
      // 创建API统计表
      await db.exec("CREATE TABLE IF NOT EXISTS api_stats (api_index INTEGER PRIMARY KEY, api_name TEXT NOT NULL, api_url TEXT NOT NULL, api_key TEXT NOT NULL, api_model TEXT NOT NULL, total_calls INTEGER DEFAULT 0, success_calls INTEGER DEFAULT 0, failed_calls INTEGER DEFAULT 0, last_call TEXT, next_scheduled_call TEXT);");
      
      // 创建API调用历史表
      await db.exec("CREATE TABLE IF NOT EXISTS api_history (id INTEGER PRIMARY KEY AUTOINCREMENT, api_index INTEGER NOT NULL, api_name TEXT NOT NULL, question TEXT NOT NULL, answer TEXT, success INTEGER NOT NULL, error TEXT, duration INTEGER, timestamp TEXT NOT NULL, FOREIGN KEY (api_index) REFERENCES api_stats(api_index));");
      
      // 创建调度表
      await db.exec("CREATE TABLE IF NOT EXISTS next_schedule (id INTEGER PRIMARY KEY CHECK (id = 1), next_time TEXT, next_api_index INTEGER);");
      
      const scheduleExists = await db.prepare("SELECT COUNT(*) as count FROM next_schedule").first();
      if (!scheduleExists || scheduleExists.count === 0) {
        await db.exec("INSERT INTO next_schedule (id, next_time, next_api_index) VALUES (1, NULL, -1);");
      }
      
      CACHE.initialized = true;
      return true;
    } catch (error) {
      console.error("数据库初始化失败:", error);
      throw error;
    }
  },

  async initApiConfigs(db) {
    dbOperationsCount++;
    try {
      const existingApis = await db.prepare("SELECT api_index FROM api_stats").all();
      const existingIndices = new Set(existingApis.results.map(row => row.api_index));
      
      const insertStmt = db.prepare(`
        INSERT INTO api_stats 
        (api_index, api_name, api_url, api_key, api_model, total_calls, success_calls, failed_calls, next_scheduled_call) 
        VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)
      `);
      
      const updateStmt = db.prepare(`
        UPDATE api_stats
        SET api_name = ?, api_url = ?, api_key = ?, api_model = ?
        WHERE api_index = ?
      `);
      
      const nextTime = new Date(Date.now() + 60000).toISOString(); // 1分钟后
      
      for (let i = 0; i < API_CONFIGS.length; i++) {
        const config = API_CONFIGS[i];
        
        if (existingIndices.has(i)) {
          await updateStmt.bind(config.name, config.url, config.apiKey, config.apiName, i).run();
        } else {
          await insertStmt.bind(i, config.name, config.url, config.apiKey, config.apiName, nextTime).run();
        }
      }
      
      CACHE.apiStats = null; // 清除缓存
      return true;
    } catch (error) {
      console.error("初始化API配置失败:", error);
      throw error;
    }
  }
};

// 存储操作模块
const Storage = {
  async getAllHistory(env) {
    const now = Date.now();
    if (CACHE.history && (now - CACHE.cacheTime < CONFIG.CACHE_TTL)) {
      return CACHE.history;
    }
    
    try {
      dbOperationsCount++;
      const history = await env.claude_keeper_d1.prepare(`
        SELECT api_index, api_name, question, answer, success, error, duration, timestamp
        FROM api_history 
        ORDER BY timestamp DESC 
        LIMIT ?
      `).bind(CONFIG.HISTORY_LIMIT).all();
      
      const formattedHistory = history.results.map(item => ({
        apiIndex: item.api_index,
        apiName: item.api_name,
        question: item.question,
        answer: item.answer || '',
        success: Boolean(item.success),
        error: item.error || '',
        duration: item.duration || 0,
        timestamp: item.timestamp
      }));
      
      CACHE.history = formattedHistory;
      CACHE.cacheTime = now;
      return formattedHistory;
    } catch (error) {
      console.error("获取历史记录失败:", error);
      return CACHE.history || [];
    }
  },

  async addHistoryBatch(items, env) {
    if (!items || items.length === 0) return true;
    
    try {
      dbOperationsCount++;
      const db = env.claude_keeper_d1;
      const stmt = db.prepare(`
        INSERT INTO api_history 
        (api_index, api_name, question, answer, success, error, duration, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      for (const item of items) {
        try {
          await stmt.bind(
            item.apiIndex,
            item.apiName,
            item.question,
            item.answer || '',
            item.success ? 1 : 0,
            item.error || '',
            item.duration || 0,
            item.timestamp
          ).run();
        } catch (itemError) {
          console.error("添加历史记录项失败:", itemError);
        }
      }
      
      // 限制历史记录数量
      await db.prepare(`
        DELETE FROM api_history 
        WHERE id NOT IN (
          SELECT id FROM api_history 
          ORDER BY timestamp DESC 
          LIMIT ?
        )
      `).bind(CONFIG.HISTORY_LIMIT).run();
      
      CACHE.history = null; // 清除缓存
      return true;
    } catch (error) {
      console.error("批量添加历史记录失败:", error);
      return false;
    }
  },

  async clearHistory(env) {
    try {
      dbOperationsCount++;
      await env.claude_keeper_d1.exec('DELETE FROM api_history;');
      CACHE.history = [];
      CACHE.cacheTime = Date.now();
      return true;
    } catch (error) {
      console.error("清空历史记录失败:", error);
      return false;
    }
  },

  async getAllStats(env) {
    const now = Date.now();
    if (CACHE.apiStats && (now - CACHE.cacheTime < CONFIG.CACHE_TTL)) {
      return CACHE.apiStats;
    }
    
    try {
      dbOperationsCount++;
      const stats = await env.claude_keeper_d1.prepare(`
        SELECT * FROM api_stats ORDER BY api_index ASC
      `).all();
      
      const apiStats = stats.results.map(stat => ({
        totalCalls: stat.total_calls || 0,
        successCalls: stat.success_calls || 0,
        failedCalls: stat.failed_calls || 0,
        lastCall: stat.last_call,
        nextScheduledCall: stat.next_scheduled_call,
        apiConfig: {
          name: stat.api_name,
          apiName: stat.api_model,
          url: stat.api_url,
          apiKey: stat.api_key
        }
      }));
      
      CACHE.apiStats = apiStats;
      CACHE.cacheTime = now;
      return apiStats;
    } catch (error) {
      console.error("获取统计数据失败:", error);
      return CACHE.apiStats || [];
    }
  },

  async batchUpdateApiStats(updates, env) {
    if (!updates || updates.length === 0) return null;
    
    try {
      dbOperationsCount++;
      const db = env.claude_keeper_d1;
      const updateStmt = db.prepare(`
        UPDATE api_stats 
        SET 
          total_calls = total_calls + 1,
          success_calls = success_calls + ?,
          failed_calls = failed_calls + ?,
          last_call = ?,
          next_scheduled_call = ?
        WHERE api_index = ?
      `);
      
      for (const update of updates) {
        const { apiIndex, success, nextCallTime } = update;
        
        try {
          await updateStmt.bind(
            success ? 1 : 0,
            success ? 0 : 1,
            new Date().toISOString(),
            nextCallTime ? nextCallTime.toISOString() : null,
            apiIndex
          ).run();
        } catch (updateError) {
          console.error("更新API统计失败:", updateError);
        }
      }
      
      CACHE.apiStats = null; // 清除缓存
      return await this.getAllStats(env);
    } catch (error) {
      console.error("批量更新统计数据失败:", error);
      return null;
    }
  }
};

// API调用模块
const ApiService = {
  getRandomQuestion() {
    return CONFIG.QUESTIONS[Math.floor(Math.random() * CONFIG.QUESTIONS.length)];
  },

  async callApi(apiIndex, retryCount = 0) {
    apiCallsCount++;
    
    let apiConfig;
    if (CACHE.apiStats && CACHE.apiStats[apiIndex]) {
      apiConfig = CACHE.apiStats[apiIndex].apiConfig;
    } else {
      throw new Error(`API配置 ${apiIndex} 未找到`);
    }
    
    const question = this.getRandomQuestion();
    console.log(`调用API: ${apiConfig.name} (流式模式)`);
    
    try {
      const startTime = Date.now();
      const response = await fetch(apiConfig.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiConfig.apiKey}`
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: question }],
          model: apiConfig.apiName,
          max_tokens: 50,
          temperature: 0.3,
          stream: true  // 启用流式响应
        })
      });

      if (!response.ok) {
        throw new Error(`API请求失败: ${response.status}`);
      }

      // 处理流式响应
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullAnswer = '';
      let chunks = [];
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          chunks.push(chunk);
          buffer += chunk;
          
          debugLog('收到流式数据块:', chunk.length, '字符');
          
          // 解析SSE数据 - 处理可能跨越多个块的数据
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // 保存可能不完整的最后一行
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              
              if (data === '[DONE]') {
                debugLog('流式数据结束');
                break;
              }
              
              if (data === '') continue; // 跳过空行
              
              try {
                const jsonData = JSON.parse(data);
                
                // 检查不同的响应格式
                const content = jsonData.choices?.[0]?.delta?.content || 
                               jsonData.choices?.[0]?.message?.content ||
                               jsonData.content;
                               
                if (content) {
                  fullAnswer += content;
                }
              } catch (parseError) {
                debugLog('解析流式数据失败:', parseError.message);
              }
            }
          }
        }
        
        // 处理缓冲区中剩余的数据
        if (buffer.trim()) {
          debugLog('处理剩余缓冲区:', buffer);
          const lines = buffer.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data && data !== '[DONE]') {
                try {
                  const jsonData = JSON.parse(data);
                  const content = jsonData.choices?.[0]?.delta?.content || 
                                 jsonData.choices?.[0]?.message?.content ||
                                 jsonData.content;
                  if (content) {
                    fullAnswer += content;
                  }
                } catch (parseError) {
                  debugLog('解析缓冲区数据失败:', parseError.message);
                }
              }
            }
          }
        }
        
      } finally {
        reader.releaseLock();
      }

      const duration = Date.now() - startTime;
      debugLog(`流式响应完成，总长度: ${fullAnswer.length}, 数据块: ${chunks.length}`);

      // 如果流式解析没有内容，尝试非流式解析
      if (!fullAnswer && chunks.length > 0) {
        debugLog('流式解析失败，尝试解析完整响应体...');
        
        const fullText = chunks.join('');
        
        try {
          const jsonResponse = JSON.parse(fullText);
          const content = jsonResponse.choices?.[0]?.message?.content || 
                         jsonResponse.choices?.[0]?.text ||
                         jsonResponse.response ||
                         jsonResponse.content;
                         
          if (content) {
            fullAnswer = content;
            debugLog('从非流式响应提取内容成功');
          }
        } catch (jsonError) {
          debugLog('非流式JSON解析失败，尝试正则提取');
          
          const textMatch = fullText.match(/"content":\s*"([^"]*?)"/);
          if (textMatch) {
            fullAnswer = textMatch[1];
          }
        }
      }

      return {
        success: true,
        apiName: apiConfig.name,
        model: apiConfig.apiName,
        url: apiConfig.url,
        question,
        answer: fullAnswer || '无响应内容',
        timestamp: new Date().toISOString(),
        duration,
        streamChunks: chunks.length,
        rawResponse: chunks.join('').substring(0, 200) + '...'  // 调试用：显示原始响应片段
      };
    } catch (error) {
      console.error(`API ${apiConfig.name} 调用失败:`, error);
      
      // 重试机制
      if (retryCount < CONFIG.MAX_RETRIES) {
        console.log(`重试 API ${apiIndex} #${retryCount + 1}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
        return this.callApi(apiIndex, retryCount + 1);
      }
      
      return {
        success: false,
        apiName: apiConfig.name,
        model: apiConfig.apiName,
        url: apiConfig.url,
        question,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  },

  async batchCallApis(apiIndices) {
    console.log(`并行调用${apiIndices.length}个API`);
    
    const apiPromises = apiIndices.map(apiIndex => this.callApi(apiIndex));
    const apiResults = await Promise.allSettled(apiPromises);
    
    const results = [];
    const historyItems = [];
    const statsUpdates = [];
    
    apiResults.forEach((result, index) => {
      const apiIndex = apiIndices[index];
      
      if (result.status === 'fulfilled') {
        results.push(result.value);
        historyItems.push({...result.value, apiIndex});
        
        const nextCallTime = new Date(Date.now() + 60000); // 1分钟后
        statsUpdates.push({
          apiIndex,
          success: result.value.success,
          nextCallTime
        });
      } else {
        console.error(`API ${apiIndex} 调用异常:`, result.reason);
        
        const errorResult = {
          success: false,
          apiName: CACHE.apiStats[apiIndex]?.apiConfig?.name || `未知API-${apiIndex}`,
          question: "调用过程异常",
          error: result.reason.message || "未知错误",
          timestamp: new Date().toISOString()
        };
        
        results.push(errorResult);
        historyItems.push({...errorResult, apiIndex});
        
        const nextCallTime = new Date(Date.now() + 60000);
        statsUpdates.push({
          apiIndex,
          success: false,
          nextCallTime
        });
      }
    });
    
    return { results, historyItems, statsUpdates };
  }
};

// HTML生成器 - 简化版
function generateStatusPage(apiStats, recentHistory) {
  const totalCalls = apiStats.reduce((sum, stats) => sum + (stats?.totalCalls || 0), 0);
  const totalSuccess = apiStats.reduce((sum, stats) => sum + (stats?.successCalls || 0), 0);
  
  const apiTableRows = apiStats.map((stats, index) => {
    const lastCall = stats.lastCall ? new Date(stats.lastCall).toLocaleString() : "从未调用";
    const nextCall = stats.nextScheduledCall ? new Date(stats.nextScheduledCall).toLocaleString() : "未安排";
    
    return `
      <tr data-api-index="${index}">
        <td title="${stats.apiConfig.name}">${stats.apiConfig.name}</td>
        <td class="last-call" title="${lastCall}">${lastCall}</td>
        <td class="next-call" title="${nextCall}">${nextCall}</td>
        <td class="call-stats">${stats.successCalls || 0}/${stats.totalCalls || 0}</td>
        <td>
          <button class="btn btn-sm btn-primary call-api-btn" data-index="${index}">调用</button>
        </td>
      </tr>
    `;
  }).join('');

  const historyHtml = renderHistoryItems(recentHistory.slice(0, 10));

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>API保活状态</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css">
        <style>
          .card { margin-bottom: 20px; }
          pre { white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
          .history-list { max-height: 400px; overflow-y: auto; }
          .compact-history { font-size: 0.9rem; padding: 4px 8px; border-left: 3px solid #e9ecef; margin-bottom: 4px; }
          .compact-history.success { border-left-color: #28a745; }
          .compact-history.error { border-left-color: #dc3545; }
          .table-fixed { table-layout: fixed; }
          .table-fixed td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        </style>
      </head>
      <body>
        <div class="container mt-4 mb-5">
          <h1 class="mb-4">API保活状态</h1>
          
          <div class="row">
            <div class="col-md-6">
              <div class="card">
                <div class="card-header">总体统计</div>
                <div class="card-body">
                  <div class="row">
                    <div class="col-6">
                      <p>总API数量:</p>
                      <p>总调用次数:</p>
                      <p>总成功次数:</p>
                      <p>总体成功率:</p>
                    </div>
                    <div class="col-6">
                      <p class="fw-bold">${apiStats.length}</p>
                      <p class="fw-bold" id="total-calls">${totalCalls}</p>
                      <p class="fw-bold" id="total-success">${totalSuccess}</p>
                      <p class="fw-bold" id="success-rate">${totalCalls > 0 ? ((totalSuccess / totalCalls) * 100).toFixed(2) : 0}%</p>
                    </div>
                  </div>
                  <p class="text-muted mt-2"><small>数据更新时间: ${new Date().toLocaleString()}</small></p>
                </div>
              </div>
            </div>
            
            <div class="col-md-6">
              <div class="card">
                <div class="card-header">API控制</div>
                <div class="card-body">
                  <div class="mb-2">
                    <select id="api-select" class="form-select">
                      ${apiStats.map((stats, index) => `<option value="${index}">${stats.apiConfig.name}</option>`).join('')}
                    </select>
                  </div>
                  <div class="d-flex">
                    <button id="trigger-api" class="btn btn-primary flex-grow-1 me-2">调用所选API</button>
                    <button id="trigger-all" class="btn btn-success flex-grow-1">调用所有API</button>
                  </div>
                  <div class="mt-2 d-flex">
                    <button id="clear-history" class="btn btn-outline-danger flex-grow-1 me-2">清空历史</button>
                    <button id="refresh-page" class="btn btn-outline-secondary flex-grow-1">刷新数据</button>
                  </div>
                  <div class="mt-2">
                    <button id="update-configs" class="btn btn-outline-primary w-100">更新API配置</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <div class="card mt-4">
            <div class="card-header">API状态</div>
            <div class="card-body">
              <div class="table-responsive">
                <table class="table table-striped table-fixed" id="api-status-table">
                  <thead>
                    <tr>
                      <th width="25%">API名称</th>
                      <th width="25%">上次调用</th>
                      <th width="25%">下次调用</th>
                      <th width="15%">成功/总调用</th>
                      <th width="10%">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${apiTableRows}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          
          <div class="card mt-4">
            <div class="card-header d-flex justify-content-between align-items-center">
              <span>最近调用历史</span>
              <span class="badge bg-secondary">${recentHistory.length}条记录</span>
            </div>
            <div class="card-body p-0">
              <div class="history-list p-3" id="recent-history">
                ${historyHtml}
              </div>
            </div>
          </div>
          
          <div id="result" class="mt-3"></div>
          
          <div class="card mt-4">
            <div class="card-header">Cron任务调试信息</div>
            <div class="card-body">
              <div id="debug-info">
                <button id="check-cron" class="btn btn-info">查看最近Cron执行情况</button>
                <div id="cron-debug-info" class="mt-3"></div>
              </div>
            </div>
          </div>
        </div>

        <script>
          let lastRefreshTime = 0;
          const MIN_REFRESH_INTERVAL = 15000;
          
          document.addEventListener('DOMContentLoaded', function() {
            setTimeout(() => setInterval(refreshPageData, 300000), 30000);
            document.getElementById('check-cron').addEventListener('click', checkCronDebug);
          });
          
          async function checkCronDebug() {
            const debugDiv = document.getElementById('cron-debug-info');
            debugDiv.innerHTML = '<div class="alert alert-info">正在获取Cron任务执行信息...</div>';
            
            try {
              const response = await fetch('/debug-cron');
              if (!response.ok) throw new Error('HTTP错误: ' + response.status);
              
              const data = await response.json();
              if (data && data.length > 0) {
                let html = '<div class="alert alert-success"><h5>最近的Cron执行记录</h5><ul>';
                data.forEach(record => {
                  const time = new Date(record.timestamp).toLocaleString();
                  const successText = record.success ? '是' : '否';
                  html += '<li>' + time + ' - API: ' + record.api_name + ' - 成功: ' + successText + '</li>';
                });
                html += '</ul></div>';
                debugDiv.innerHTML = html;
              } else {
                debugDiv.innerHTML = '<div class="alert alert-warning">没有找到最近的Cron执行记录</div>';
              }
            } catch (error) {
              debugDiv.innerHTML = '<div class="alert alert-danger">获取Cron执行信息失败: ' + error.message + '</div>';
            }
          }
          
          async function callApi(apiIndex) {
            const resultDiv = document.getElementById('result');
            resultDiv.innerHTML = '<div class="alert alert-info">正在调用API...</div>';
            
            try {
              const response = await fetch('/invoke/' + apiIndex);
              if (!response.ok) throw new Error('HTTP错误: ' + response.status);
              
              const data = await response.json();
              
              let html = '<div class="alert ' + (data.success ? 'alert-success' : 'alert-danger') + '">';
              if (data.success) {
                html += '<h5>✓ 调用成功 (流式模式)</h5>';
                html += '<p><strong>API:</strong> ' + data.apiName + '</p>';
                html += '<p><strong>问题:</strong> ' + data.question + '</p>';
                html += '<p><strong>耗时:</strong> ' + data.duration + 'ms</p>';
                if (data.streamChunks) {
                  html += '<p><strong>流式数据块:</strong> ' + data.streamChunks + '个</p>';
                }
                if (data.rawResponse) {
                  html += '<details><summary><strong>调试信息 (点击展开)</strong></summary>';
                  html += '<pre class="bg-warning p-2 rounded mt-2" style="font-size: 0.8rem;">' + data.rawResponse + '</pre>';
                  html += '</details>';
                }
                html += '<p><strong>回答:</strong></p>';
                html += '<pre class="bg-light p-2 rounded">' + data.answer + '</pre>';
              } else {
                html += '<h5>✗ 调用失败</h5>';
                html += '<p><strong>API:</strong> ' + data.apiName + '</p>';
                html += '<p><strong>问题:</strong> ' + data.question + '</p>';
                html += '<p><strong>错误:</strong> ' + data.error + '</p>';
              }
              html += '</div>';
              
              resultDiv.innerHTML = html;
              setTimeout(refreshPageData, 1000);
            } catch (error) {
              resultDiv.innerHTML = '<div class="alert alert-danger">请求失败: ' + error.message + '</div>';
            }
          }
          
          async function callAllApis() {
            const resultDiv = document.getElementById('result');
            resultDiv.innerHTML = '<div class="alert alert-info">正在调用所有API...</div>';
            
            try {
              const response = await fetch('/invoke-all');
              if (!response.ok) throw new Error('HTTP错误: ' + response.status);
              
              const data = await response.json();
              
              let html = '<div class="alert alert-success"><h5>API调用结果</h5><ul class="mb-0">';
              data.forEach(result => {
                if (result.success) {
                  html += '<li>' + result.apiName + ' 调用成功</li>';
                } else {
                  html += '<li>' + result.apiName + ' 调用失败: ' + result.error + '</li>';
                }
              });
              html += '</ul></div>';
              
              resultDiv.innerHTML = html;
              setTimeout(refreshPageData, 1000);
            } catch (error) {
              resultDiv.innerHTML = '<div class="alert alert-danger">请求失败: ' + error.message + '</div>';
            }
          }
          
          async function clearHistory() {
            if (confirm('确定要清空所有历史记录吗？')) {
              try {
                const response = await fetch('/api/clear-history', { method: 'POST' });
                const data = await response.json();
                
                if (data.success) {
                  document.getElementById('recent-history').innerHTML = '<p class="text-muted">暂无历史记录</p>';
                  alert('历史记录已清空');
                } else {
                  alert('清空历史记录失败');
                }
              } catch (error) {
                alert('请求失败: ' + error.message);
              }
            }
          }
          
          async function updateApiConfigs() {
            if (confirm('确定要更新API配置吗？这将使用代码中的最新配置覆盖现有配置。')) {
              try {
                const response = await fetch('/api/update-configs', { method: 'POST' });
                const data = await response.json();
                
                if (data.success) {
                  alert('API配置已更新，页面将刷新');
                  window.location.reload();
                } else {
                  alert('更新API配置失败: ' + (data.error || '未知错误'));
                }
              } catch (error) {
                alert('请求失败: ' + error.message);
              }
            }
          }
          
          async function refreshPageData() {
            const now = Date.now();
            if (now - lastRefreshTime < MIN_REFRESH_INTERVAL) return;
            lastRefreshTime = now;
            
            try {
              const response = await fetch('/api/data');
              if (!response.ok) throw new Error('HTTP错误: ' + response.status);
              
              const data = await response.json();
              
              document.getElementById('recent-history').innerHTML = renderHistoryItems(data.history);
              document.getElementById('total-calls').textContent = data.totalCalls;
              document.getElementById('total-success').textContent = data.totalSuccess;
              document.getElementById('success-rate').textContent = 
                (data.totalCalls > 0 ? ((data.totalSuccess / data.totalCalls) * 100).toFixed(2) : 0) + '%';
              
              const table = document.getElementById('api-status-table');
              const rows = table.querySelectorAll('tbody tr');
              
              data.apiStats.forEach((stat, index) => {
                const row = rows[index];
                if (row) {
                  const lastCallCell = row.querySelector('.last-call');
                  if (lastCallCell && stat.lastCall) {
                    const lastCallTime = new Date(stat.lastCall).toLocaleString();
                    lastCallCell.textContent = lastCallTime;
                    lastCallCell.title = lastCallTime;
                  }
                  
                  const nextCallCell = row.querySelector('.next-call');
                  if (nextCallCell && stat.nextScheduledCall) {
                    const nextCallTime = new Date(stat.nextScheduledCall).toLocaleString();
                    nextCallCell.textContent = nextCallTime;
                    nextCallCell.title = nextCallTime;
                  }
                  
                  const callStatsCell = row.querySelector('.call-stats');
                  if (callStatsCell) {
                    callStatsCell.textContent = (stat.successCalls || 0) + '/' + (stat.totalCalls || 0);
                  }
                }
              });
              console.log('页面数据已刷新');
            } catch (error) {
              console.error('刷新页面数据失败:', error);
            }
          }
          
          function renderHistoryItems(items) {
            if (!items || items.length === 0) {
              return '<p class="text-muted p-3">暂无历史记录</p>';
            }
            
            let html = '';
            items.forEach(item => {
              html += '<div class="compact-history ' + (item.success ? 'success' : 'error') + '">';
              html += '<div class="d-flex justify-content-between align-items-center">';
              html += '<span><strong>' + item.apiName + '</strong> · ' + item.question + '</span>';
              html += '<small class="text-muted">' + formatTime(new Date(item.timestamp)) + '</small>';
              html += '</div>';
              
              if (item.success) {
                const answer = item.answer || '';
                html += '<div class="text-success">' + answer.substring(0, 80) + (answer.length > 80 ? '...' : '') + '</div>';
              } else {
                html += '<div class="text-danger">错误: ' + (item.error || '未知错误') + '</div>';
              }
              
              html += '</div>';
            });
            
            return html;
          }
          
          function formatTime(date) {
            return date.toLocaleTimeString();
          }
          
          // 绑定事件
          document.getElementById('trigger-api').addEventListener('click', () => {
            const apiIndex = document.getElementById('api-select').value;
            callApi(apiIndex);
          });
          
          document.getElementById('trigger-all').addEventListener('click', callAllApis);
          document.getElementById('clear-history').addEventListener('click', clearHistory);
          document.getElementById('refresh-page').addEventListener('click', refreshPageData);
          document.getElementById('update-configs').addEventListener('click', updateApiConfigs);
          
          document.querySelectorAll('.call-api-btn').forEach(btn => {
            btn.addEventListener('click', function() {
              callApi(this.dataset.index);
            });
          });
        </script>
      </body>
    </html>
  `;
}

function renderHistoryItems(items) {
  if (!items || items.length === 0) {
    return '<p class="text-muted">暂无历史记录</p>';
  }
  
  let html = '';
  items.forEach(item => {
    html += '<div class="compact-history ' + (item.success ? 'success' : 'error') + '">';
    html += '<div class="d-flex justify-content-between align-items-center">';
    html += '<span><strong>' + item.apiName + '</strong> · ' + item.question + '</span>';
    html += '<small class="text-muted">' + formatTime(new Date(item.timestamp)) + '</small>';
    html += '</div>';
    
    if (item.success) {
      const answer = item.answer || '';
      const streamInfo = item.streamChunks ? ` (流式: ${item.streamChunks}块)` : '';
      html += '<div class="text-success">' + answer.substring(0, 80) + (answer.length > 80 ? '...' : '') + streamInfo + '</div>';
    } else {
      html += '<div class="text-danger">错误: ' + (item.error || '未知错误') + '</div>';
    }
    
    html += '</div>';
  });
  
  return html;
}

function formatTime(date) {
  return date.toLocaleTimeString();
}

// Worker主体
export default {
  async fetch(request, env, ctx) {
    dbOperationsCount = 0;
    apiCallsCount = 0;
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    try {
      // 初始化数据库
      const db = env.claude_keeper_d1;
      await Database.init(db);
      await Database.initApiConfigs(db);
      
      // 预加载API统计数据
      if (!CACHE.apiStats) {
        await Storage.getAllStats(env);
      }
      
      // 路由处理
      if (path.startsWith("/invoke/")) {
        const apiIndex = parseInt(path.split("/")[2]);
        
        if (isNaN(apiIndex) || apiIndex < 0 || apiIndex >= CACHE.apiStats.length) {
          return new Response(JSON.stringify({
            success: false,
            error: "无效的API索引"
          }), {
            headers: { 'Content-Type': 'application/json' },
            status: 400
          });
        }
        
        debugLog(`开始调用API，索引: ${apiIndex}, 总数: ${CACHE.apiStats.length}`);
        
        const result = await ApiService.callApi(apiIndex);
        debugLog(`API调用结果:`, result.success ? '成功' : '失败');
        
        await Storage.addHistoryBatch([{...result, apiIndex}], env);
        
        const nextCallTime = new Date(Date.now() + 60000);
        await Storage.batchUpdateApiStats([{ apiIndex, success: result.success, nextCallTime }], env);
        
        return new Response(JSON.stringify(result), {
          headers: { 
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache'
          }
        });
      } 
      else if (path === "/invoke-all") {
        const apiIndices = Array.from({ length: CACHE.apiStats.length }, (_, i) => i);
        const { results, historyItems, statsUpdates } = await ApiService.batchCallApis(apiIndices);
        
        if (historyItems.length > 0) {
          await Storage.addHistoryBatch(historyItems, env);
        }
        
        if (statsUpdates.length > 0) {
          await Storage.batchUpdateApiStats(statsUpdates, env);
        }
        
        return new Response(JSON.stringify(results), {
          headers: { 
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache'
          }
        });
      }
      else if (path === "/api/data") {
        const [apiStats, history] = await Promise.all([
          Storage.getAllStats(env),
          Storage.getAllHistory(env)
        ]);
        
        const totalCalls = apiStats.reduce((sum, stats) => sum + (stats?.totalCalls || 0), 0);
        const totalSuccess = apiStats.reduce((sum, stats) => sum + (stats?.successCalls || 0), 0);
        
        return new Response(JSON.stringify({
          apiStats,
          history: history.slice(0, 10),
          totalCalls,
          totalSuccess
        }), {
          headers: { 
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=5'
          }
        });
      }
      else if (path === "/api/clear-history" && request.method === "POST") {
        const success = await Storage.clearHistory(env);
        return new Response(JSON.stringify({ success }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      else if (path === "/api/update-configs" && request.method === "POST") {
        await Database.initApiConfigs(env.claude_keeper_d1);
        CACHE.apiStats = null;
        return new Response(JSON.stringify({ 
          success: true,
          message: "API配置已更新"
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } 
      else if (path === "/debug-cron") {
        const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
        
        const recentLogs = await env.claude_keeper_d1.prepare(`
          SELECT api_index, api_name, question, success, timestamp 
          FROM api_history 
          WHERE timestamp > ? 
          ORDER BY timestamp DESC LIMIT 20
        `).bind(oneHourAgo).all();
        
        return new Response(JSON.stringify(recentLogs.results), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      else if (path === "/status" || path === "/") {
        const [apiStats, history] = await Promise.all([
          Storage.getAllStats(env),
          Storage.getAllHistory(env)
        ]);
        
        return new Response(generateStatusPage(apiStats, history), {
          headers: { 
            'Content-Type': 'text/html',
            'Cache-Control': 'public, max-age=60'
          }
        });
      }
      else {
        return new Response(`
          <h1>404 - 页面未找到</h1>
          <p><a href="/">返回主页</a></p>
        `, {
          headers: { 'Content-Type': 'text/html' },
          status: 404
        });
      }
    } catch (error) {
      console.error('请求处理错误:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '服务器错误: ' + (error.message || '未知错误'),
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 500
      });
    } finally {
      console.log('请求完成: 执行了 ' + apiCallsCount + ' 次API调用和 ' + dbOperationsCount + ' 次数据库操作');
    }
  },

  async scheduled(event, env, ctx) {
    dbOperationsCount = 0;
    apiCallsCount = 0;
    
    console.log('定时任务触发', new Date().toISOString());
    
    try {
      await Database.init(env.claude_keeper_d1);
      await Database.initApiConfigs(env.claude_keeper_d1);
      
      const apiStats = await Storage.getAllStats(env);
      const apiIndices = Array.from({ length: apiStats.length }, (_, i) => i);
      
      console.log('准备调用所有API:', apiIndices);
      
      const { results, historyItems, statsUpdates } = await ApiService.batchCallApis(apiIndices);
      
      console.log(`得到${results.length}个结果, ${historyItems.length}条历史记录, ${statsUpdates.length}项统计更新`);
      
      if (historyItems.length > 0) {
        console.log(`保存${historyItems.length}条调用历史`);
        await Storage.addHistoryBatch(historyItems, env);
      }
      
      if (statsUpdates.length > 0) {
        console.log(`更新${statsUpdates.length}项API统计`);
        await Storage.batchUpdateApiStats(statsUpdates, env);
      }
      
      // 添加Cron标记
      try {
        const cronMarker = {
          apiIndex: 0,
          apiName: 'CRON-TASK',
          question: 'Cron任务自动调用',
          answer: `调用了${results.length}个API, 成功${results.filter(r => r.success).length}个`,
          success: true,
          timestamp: new Date().toISOString()
        };
        
        await Storage.addHistoryBatch([cronMarker], env);
        console.log('添加Cron标记成功');
      } catch (markerError) {
        console.error('添加Cron标记失败:', markerError);
      }
      
      const successCount = results.filter(result => result.success).length;
      console.log('API调用完成: 成功 ' + successCount + '/' + results.length);
    } catch (error) {
      console.error('定时任务执行错误:', error);
    } finally {
      console.log('定时任务完成: 执行了 ' + apiCallsCount + ' 次API调用和 ' + dbOperationsCount + ' 次数据库操作');
    }
  }
};