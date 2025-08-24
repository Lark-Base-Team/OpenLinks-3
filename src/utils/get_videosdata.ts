import { bitable, FieldType, ITable, IRecord, IFieldMeta } from '@lark-base-open/js-sdk';
import axios from 'axios';

// 定义后端 API 的基础 URL
const API_BASE_URL = 'https://www.ccai.fun';

// 定义从后端 API 返回的视频数据的接口结构
interface Video {
  nickname: string;         // 视频作者昵称
  aweme_id: string;         // 视频的唯一标识符 (视频编号)
  share_url: string;        // 视频分享链接
  conv_create_time: string | null; // 视频发布时间 (可能是多种格式: YYYYMMDD, 时间戳秒/毫秒, 标准日期字符串)
  desc: string;             // 视频描述/标题
  digg_count: number;       // 点赞数 (后端返回整数类型)
  collect_count: number;    // 收藏数 (后端返回整数类型)
  comment_count: number;    // 评论数 (后端返回整数类型)
  duration: number;         // 视频时长 (毫秒, 后端返回整数类型)
  play_addr: string;        // 视频播放/下载地址
  audio_addr: string;       // 音频播放/下载地址
  share_count: number;      // 分享数 (后端返回整数类型)
  video_text_ori?: string;  // 原始ASR文案 (可选)
  video_text_arr?: string;  // LLM整理后文案 (可选)
}

// 定义前端数据模型到飞书表格字段的映射关系
// key: 后端返回的 Video 接口中的字段名
// value: { name: 飞书表格中的字段名, type: 飞书表格中的字段类型 }
const fieldMapping: { [key: string]: { name: string; type: FieldType } } = {
  nickname: { name: '昵称', type: FieldType.Text },
  aweme_id: { name: '视频编号', type: FieldType.Text }, // 这个字段用于去重
  share_url: { name: '分享链接', type: FieldType.Url },
  conv_create_time: { name: '发布日期', type: FieldType.DateTime },
  desc: { name: '描述', type: FieldType.Text },
  digg_count: { name: '点赞数', type: FieldType.Number },
  collect_count: { name: '收藏数', type: FieldType.Number },
  comment_count: { name: '评论数', type: FieldType.Number },
  duration: { name: '时长', type: FieldType.Number }, // 单位：秒
  play_addr: { name: '下载链接', type: FieldType.Url },
  audio_addr: { name: '音频链接', type: FieldType.Url },
  share_count: { name: '分享数', type: FieldType.Number },
  video_text_arr: { name: '文案', type: FieldType.Text }, // 添加文案字段
};

/**
 * 获取或创建指定名称的表格。
 * 如果表格已存在，则返回该表格对象。
 * 如果表格不存在，则创建新表格，并将主字段（通常是第一列）尝试重命名为 "视频编号"。
 * @param tableName 要获取或创建的表格名称 (通常是视频作者的昵称)。
 * @param logger 日志记录函数。
 * @returns 返回 Promise，解析为飞书表格对象 ITable。
 * @throws 如果无法获取或创建表格实例，则抛出错误。
 */
async function getOrCreateTable(tableName: string, logger: (message: string) => void): Promise<ITable> {
  // 获取 bitable base 对象
  const base = bitable.base;
  // 获取当前 base 下的所有表格元数据列表
  const tables = await base.getTableMetaList();
  // 查找是否存在名称匹配的表格
  let tableMeta = tables.find(t => t.name === tableName);
  let table: ITable;
  let isNewTable = false; // 标记是否是新创建的表格

  // 如果找不到同名表格
  if (!tableMeta) {
    logger(`表格 "${tableName}" 不存在，正在创建...`);
    try {
      // 调用 SDK 创建新表格，只指定名称，字段稍后处理
      const { tableId } = await base.addTable({ name: tableName, fields: [] });
      // 根据返回的 tableId 获取新创建的表格对象
      table = await base.getTableById(tableId);
      isNewTable = true; // 标记为新表
      logger(`表格 "${tableName}" 创建成功，ID: ${tableId}`);
    } catch (error) {
      logger(`创建表格 "${tableName}" 失败: ${error}`);
      throw error; // 抛出错误，中断后续操作
    }
  } else {
    // 如果找到同名表格，根据其 ID 获取表格对象
    table = await base.getTableById(tableMeta.id);
    logger(`找到现有表格 "${tableName}"，ID: ${tableMeta.id}`);
  }

  // 双重检查，确保成功获取到表格对象
  if (!table) {
    throw new Error(`无法获取表格 "${tableName}" 的实例`);
  }

  // --- 新表的主字段重命名逻辑 ---
  // 如果是新创建的表格
  if (isNewTable) {
    try {
      // 获取新表格默认创建的字段列表
      const initialFields = await table.getFieldMetaList();
      // 查找其中的主字段 (isPrimary 属性为 true)
      const primaryField = initialFields.find(f => f.isPrimary);
      // 如果找到了主字段
      if (primaryField) {
        logger(`新表格 "${tableName}"：找到主字段 "${primaryField.name}" (ID: ${primaryField.id})，尝试重命名为 "视频编号"...`);
        // 调用 SDK 设置字段属性，只修改名称
        await table.setField(primaryField.id, { name: '视频编号' });
        logger(`主字段已重命名为 "视频编号"`);
      } else {
        // 一般不太可能发生，但以防万一
        logger(`警告：新表格 "${tableName}" 未找到主字段，无法自动重命名。`);
      }
    } catch (renameError) {
      // 如果重命名失败，记录错误，但不中断流程
      logger(`重命名主字段为 "视频编号" 时出错: ${renameError}`);
    }
  }

  // 返回获取到或新创建的表格对象
  return table;
}

/**
 * 确保表格中存在 fieldMapping 中定义的所有必需字段。
 * 如果字段不存在，则尝试创建它（除了 "视频编号" 字段，因为它由 getOrCreateTable 处理）。
 * @param table 要检查和操作的飞书表格对象 ITable。
 * @param logger 日志记录函数。
 * @returns 返回 Promise，解析为一个对象，其键是字段名，值是对应的字段 ID。
 */
async function ensureFieldsExist(table: ITable, logger: (message: string) => void): Promise<{ [key: string]: string }> {
  // 获取表格当前所有字段的元数据列表
  const fieldsMeta = await table.getFieldMetaList();
  // 创建一个包含现有字段名的 Set，方便快速查找
  const existingFieldNames = new Set(fieldsMeta.map(f => f.name));
  // 初始化字段名到字段 ID 的映射对象
  const fieldMap: { [key: string]: string } = {};

  fieldsMeta.forEach(field => {
    fieldMap[field.name] = field.id;
  });

  logger(`开始检查表格 "${await table.getName()}" 的字段...`);

  // 遍历 fieldMapping 中定义的期望字段
  for (const key in fieldMapping) {
    const fieldInfo = fieldMapping[key]; // 获取期望字段的信息 { name, type }
    const targetFieldName = fieldInfo.name; // 期望的字段名

    // --- 检查并创建缺失字段的逻辑 ---
    // 检查条件：
    // 1. 现有字段名 Set 中不包含此字段名
    // 2. 并且此字段名不是 "视频编号" (因为 "视频编号" 要么是重命名的主字段，要么已存在)
    if (!existingFieldNames.has(targetFieldName) && targetFieldName !== '视频编号') {
      try {
        logger(`字段 "${targetFieldName}" 不存在，正在创建...`);
        // 调用 SDK 添加字段，指定类型和名称
        const newField = await table.addField({
          type: fieldInfo.type as any, // 使用 as any 避免 FieldType 联合类型过于严格的问题
          name: targetFieldName,
        });
        // 检查 addField 的返回值是否包含 id (SDK 版本差异可能导致返回值不同)
        if (newField && typeof newField === 'object' && 'id' in newField) {
            const fieldWithId = newField as { id: string }; // 类型断言
            logger(`字段 "${targetFieldName}" 创建成功，ID: ${fieldWithId.id}`);
            fieldMap[targetFieldName] = fieldWithId.id; // 将新字段加入映射
        } else {
             // 如果返回值没有 id，记录日志并尝试重新获取字段列表来更新映射
             logger(`字段 "${targetFieldName}" 创建成功，但无法从返回值获取 ID。返回结构: ${JSON.stringify(newField)}`);
             const updatedFieldsMeta = await table.getFieldMetaList();
             updatedFieldsMeta.forEach(field => { fieldMap[field.name] = field.id; });
        }
      } catch (error) {
        // 创建字段失败，记录错误，后续写入会跳过此字段
        logger(`创建字段 "${targetFieldName}" 失败: ${error}`);
      }
    }
    // 如果字段已存在
    else if (existingFieldNames.has(targetFieldName)) {
        // 确保现有字段的 ID 在 fieldMap 中 (通常在初始填充时已加入)
        if (!fieldMap[targetFieldName]) {
            const existingField = fieldsMeta.find(f => f.name === targetFieldName);
            if (existingField) {
                fieldMap[targetFieldName] = existingField.id;
            }
        }
    }
    // 如果是 "视频编号" 字段
    else if (targetFieldName === '视频编号') {
        logger(`字段 "${targetFieldName}" 由主字段重命名处理或已存在。`);
        // 确保 "视频编号" 的 ID 在 fieldMap 中
        if (!fieldMap[targetFieldName]) {
            // 尝试在字段列表中查找名为 "视频编号" 的字段
            const videoIdField = fieldsMeta.find(f => f.name === targetFieldName);
            if (videoIdField) {
                fieldMap[targetFieldName] = videoIdField.id;
            } else {
                 // 如果找不到，说明重命名可能失败或表格结构异常
                 logger(`警告：无法在最终字段列表中找到 "视频编号" 字段的 ID。`);
            }
        }
    }
  }
  logger('字段检查完成.');

  // --- 最终检查 fieldMap 是否完整 ---
  for (const key in fieldMapping) {
      // 检查 fieldMapping 中定义的每个字段名，是否都在最终的 fieldMap 中找到了对应的 ID
      if (!fieldMap[fieldMapping[key].name]) {
          logger(`警告：最终字段映射中缺少字段 "${fieldMapping[key].name}" 的 ID。后续写入将跳过此字段。`);
      }
  }
  // 返回最终的字段名 -> 字段 ID 映射
  return fieldMap;
}

/**
 * 主函数：从后端 API 获取视频数据，并将其写入指定的飞书多维表格。
 * 会根据视频作者昵称自动选择或创建表格。
 * 会检查视频编号是否已存在，避免重复添加。
 * @param username 用户名 (用于 API 认证)。
 * @param passtoken 认证令牌/密码 (用于 API 认证)。
 * @param platform 视频平台 ('douyin' 或 'tiktok')。
 * @param linkType 链接类型 ('homepage' 或 'videourl')。
 * @param updateMethod 更新方式 ('extract' 或 'update')。
 * @param pageCount 翻页数 (用于获取主页链接时)。
 * @param url 用户输入的 URL (可能包含多个，用换行符分隔)。
 * @param logger 日志记录函数。
 */
export async function getVideosData(
  username: string,
  passtoken: string,
  platform: string,
  linkType: string,
  updateMethod: string,
  pageCount: number,
  url: string,
  logger: (message: string) => void
) {
  logger('开始获取视频数据...');

  // --- 输入参数校验 ---
  if (!username || !passtoken) {
    logger('错误：用户名和密码不能为空');
    return; // 中断执行
  }
  if (!url) {
    logger('错误：URL 不能为空');
    return; // 中断执行
  }

  // --- URL 处理 ---
  // 将输入的多行 URL 字符串分割成数组，去除首尾空格并过滤掉空行
  const urls = url.split('\n').map(line => line.trim()).filter(line => line);
  if (urls.length === 0) {
    logger('错误：未提供有效的 URL');
    return; // 中断执行
  }

  logger(`准备处理 ${urls.length} 个链接...`);

  // --- 循环处理每个 URL ---
  for (const singleUrl of urls) {
    logger(`\n处理链接: ${singleUrl}`);
    try {
      // --- 构造 API 请求数据 ---
      const requestData = {
    username: username,
        passtoken: passtoken,
    platform: platform,
        url_type: linkType,         // 使用后端期望的字段名
        url_process_type: updateMethod, // 使用后端期望的字段名
        page_turns: pageCount,       // 使用后端期望的字段名
        raw_url_inputs: singleUrl,   // 使用后端期望的字段名
      };

      // --- 根据平台选择正确的API端点 ---
      const getApiEndpoint = (platform: string) => {
        switch(platform) {
          case 'douyin':
            return `${API_BASE_URL}/api/video/douyin-data`;
          case 'tiktok':
            return `${API_BASE_URL}/api/video/tiktok-data`;
          default:
            throw new Error(`不支持的平台: ${platform}`);
        }
      };

      const apiEndpoint = getApiEndpoint(platform);
      logger(`发送请求到 ${apiEndpoint}`);
      logger(`请求数据: ${JSON.stringify(requestData, null, 2)}`);

      // --- 发送 API 请求 ---
      const response = await axios.post(apiEndpoint, requestData);

      logger(`收到响应: ${JSON.stringify(response.data, null, 2)}`);

      // --- 处理 API 响应 ---
      // 检查响应数据结构是否符合预期
      if (response.data && response.data.videos) {
        const videos: Video[] = response.data.videos; // 获取视频数据数组
        logger(`成功获取 ${videos.length} 条视频数据`);

        // 如果 API 返回了视频数据
        if (videos.length > 0) {
          // --- 确定目标表格 ---
          // 使用第一个视频的昵称作为表格名称，如果昵称为空则使用默认名称
          const tableName = videos[0].nickname || '未命名视频集';
          logger(`准备将数据写入表格: "${tableName}"`);

          // --- 获取或创建表格实例 ---
          const table = await getOrCreateTable(tableName, logger);

          // --- 确保字段存在并获取字段映射 ---
          const fieldMap = await ensureFieldsExist(table, logger);

          // --- **核心去重逻辑：获取现有视频编号** ---
          const videoIdFieldName = fieldMapping['aweme_id'].name; // 获取 "视频编号" 字段的名称
          const videoIdFieldId = fieldMap[videoIdFieldName]; // 从映射中获取 "视频编号" 字段的 ID
          let existingVideoIds = new Map<string, string>(); // 创建 Map 存储现有视频编号 (key: 清理后的视频ID, value: 记录ID)

          // 检查是否成功获取到 "视频编号" 字段的 ID
          if (videoIdFieldId) {
             logger(`正在获取表格 "${tableName}" 中现有的视频编号 (字段ID: ${videoIdFieldId})...`);
             try {
                // --- 修改：使用 getRecords 分页获取所有记录 ---
                let allRecords: IRecord[] = []; // 用于存储所有获取到的记录
                let pageToken: string | undefined = undefined; // 分页标记
                let hasMore = true;
                let totalFetched = 0;

                logger('开始分页获取所有记录...');
                while (hasMore) {
                  try {
                    // --- 修改：为 response 添加类型注解 ---
                    const response: {
                      records?: IRecord[];
                      hasMore: boolean;
                      pageToken?: string;
                      total?: number; // 添加 total 属性类型
                    } = await table.getRecords({
                      pageSize: 5000, // 每次最多获取 5000 条
                      pageToken: pageToken,
                    });

                    // 将当前批次的记录添加到总列表中
                    if (response.records) {
                      allRecords = allRecords.concat(response.records);
                      // --- 修改：安全访问 total 属性 ---
                      const totalCount = response.total ?? totalFetched; // 如果 total 不存在，使用已获取数量
                      totalFetched += response.records.length;
                      logger(`已获取 ${totalFetched}/${totalCount} 条记录...`);
                    } else {
                      logger('警告：getRecords 返回的批次中没有 records 数组');
                    }

                    // 更新分页标记和状态
                    hasMore = response.hasMore;
                    pageToken = response.pageToken;

                  } catch (getRecordsError) {
                    logger(`分页获取记录时出错: ${getRecordsError}`);
                    hasMore = false; // 出错时停止获取
                  }
                }
                logger(`所有记录获取完毕，共 ${allRecords.length} 条。`);
                // --- 结束分页获取 ---

                logger(`开始遍历 ${allRecords.length} 条现有记录以提取视频编号...`);
                // 遍历获取到的所有记录 (使用 allRecords 替代之前的 records)
                for(const record of allRecords){
                    try {
                        // 使用 getCellString 获取 "视频编号" 单元格的文本值
                        const videoIdString = await table.getCellString(videoIdFieldId, record.recordId);
                        if (videoIdString) {
                            // 清理视频编号并存入 Map
                            const cleanVideoId = videoIdString.trim().toLowerCase();
                            existingVideoIds.set(cleanVideoId, record.recordId);
                        }
                    } catch (cellError) {
                        logger(`获取记录 ${record.recordId} 的视频编号时出错: ${cellError}`);
                    }
                }
                logger(`成功获取并处理了 ${existingVideoIds.size} 个现有视频编号`);
             } catch (e) {
                // 这个 catch 现在主要捕获分页逻辑之外的错误
                logger(`处理现有视频编号时发生意外错误: ${e}`);
            }
          } else {
             logger(`警告：无法找到 "${videoIdFieldName}" 字段的 ID，将添加所有记录为新记录。`);
          }

          // --- 准备待添加和待更新的记录数据 ---
          const recordsToAdd: { fields: { [key: string]: any } }[] = [];
          const recordsToUpdate: { recordId: string; fields: { [key: string]: any } }[] = [];

          // 遍历从 API 获取的视频数据
          for (const video of videos) {
            // logger(`完整原始视频数据: ${JSON.stringify(video)}`); // 可选调试日志

            const fields: { [key: string]: any } = {}; // 用于存储单条记录的字段数据 { fieldId: value }
            let hasRequiredId = false; // 标记当前视频是否有有效的 "视频编号"

            // --- 映射 "视频编号" 字段 ---
            if (fieldMap['视频编号']) {
                // 将 aweme_id 转换为字符串，并赋值给 "视频编号" 字段
                fields[fieldMap['视频编号']] = String(video.aweme_id);
                hasRequiredId = true; // 标记成功获取到必需的 ID
            } else {
                // 如果 "视频编号" 字段映射不存在，则无法处理此视频
                logger(`警告：缺少 "视频编号" 字段映射，无法处理视频 ${video.aweme_id}`);
                continue; // 跳过当前视频，处理下一个
            }

            // --- 映射其他字段 ---
            // 对每个字段，先检查 fieldMap 中是否存在对应的字段 ID
            // 如果存在，则从 video 对象中取值，进行必要的类型转换，然后赋值
            if (fieldMap['昵称']) fields[fieldMap['昵称']] = String(video.nickname || '');
            if (fieldMap['分享链接']) fields[fieldMap['分享链接']] = String(video.share_url || '');
            if (fieldMap['发布日期']) {
                // 调用前面定义的日期处理逻辑
                try {
                    const rawValue = video.conv_create_time;
                    let timestamp: number | null = null;

                    if (typeof rawValue === 'string') {
                        // 优先检查 YYYYMMDD 格式 (8位数字)
                        if (/^\d{8}$/.test(rawValue)) {
                            const year = parseInt(rawValue.substring(0, 4), 10);
                            const month = parseInt(rawValue.substring(4, 6), 10) - 1; // 月份从0开始
                            const day = parseInt(rawValue.substring(6, 8), 10);
                            const date = new Date(Date.UTC(year, month, day)); // 使用 UTC 避免时区问题
                            if (!isNaN(date.getTime()) && date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day) {
                                timestamp = date.getTime();
                            } else {
                                logger(`警告：视频 ${video.aweme_id} 的发布日期 YYYYMMDD "${rawValue}" 无法解析为有效日期`);
                            }
                        }
                        // 再检查标准日期格式字符串
                        else if (rawValue.match(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/)) {
                            const date = new Date(rawValue);
                            if (!isNaN(date.getTime())) {
                                timestamp = date.getTime();
                                logger(`视频 ${video.aweme_id} 的发布日期 "${rawValue}" 解析为 ${new Date(timestamp).toISOString()}`);
                            } else {
                                logger(`警告：视频 ${video.aweme_id} 的发布日期 "${rawValue}" 无法解析为有效日期`);
                            }
                        }
                        // 最后检查是否是时间戳字符串
                        else if (/^\d+$/.test(rawValue)) {
                            const numValue = parseInt(rawValue, 10);
                            const ts = rawValue.length <= 10 ? numValue * 1000 : numValue;
                            const year = new Date(ts).getFullYear();
                            if (year >= 2010 && year <= 2030) {
                                timestamp = ts;
                                logger(`视频 ${video.aweme_id} 的发布日期时间戳 "${rawValue}" 解析为 ${new Date(timestamp).toISOString()}`);
                            } else {
                                logger(`警告：视频 ${video.aweme_id} 的发布日期时间戳 "${rawValue}" 解析为 ${new Date(ts).toISOString()}，年份 ${year} 超出合理范围`);
                            }
                        } else {
                            logger(`警告：视频 ${video.aweme_id} 的发布日期字符串 "${rawValue}" 格式不支持`);
                        }
                    }
                    // 处理数字类型时间戳
                    else if (typeof rawValue === 'number') {
                        const ts = rawValue < 10000000000 ? rawValue * 1000 : rawValue;
                        const year = new Date(ts).getFullYear();
                        if (year >= 2010 && year <= 2030) {
                            timestamp = ts;
                            logger(`视频 ${video.aweme_id} 的发布日期数字 ${rawValue} 解析为 ${new Date(timestamp).toISOString()}`);
                        } else {
                            logger(`警告：视频 ${video.aweme_id} 的发布日期数字 ${rawValue} 解析为 ${new Date(ts).toISOString()}，年份 ${year} 超出合理范围`);
                        }
                    } else {
                        logger(`警告：视频 ${video.aweme_id} 的发布日期 "${rawValue}" (${typeof rawValue}) 格式不支持`);
                    }

                    // 如果成功解析出时间戳，则赋值给 "发布日期" 字段
                    if (timestamp !== null) {
                        fields[fieldMap['发布日期']] = timestamp;
                    }

                } catch (dateError) {
                    logger(`警告：处理视频 ${video.aweme_id} 的发布日期时出错: ${dateError}`);
                }
            }
            if (fieldMap['描述']) fields[fieldMap['描述']] = String(video.desc || '');
            // 后端返回的是数字类型，直接使用或提供默认值 0
            if (fieldMap['点赞数']) fields[fieldMap['点赞数']] = typeof video.digg_count === 'number' ? video.digg_count : 0;
            if (fieldMap['收藏数']) fields[fieldMap['收藏数']] = typeof video.collect_count === 'number' ? video.collect_count : 0;
            if (fieldMap['评论数']) fields[fieldMap['评论数']] = typeof video.comment_count === 'number' ? video.comment_count : 0;
            if (fieldMap['时长']) fields[fieldMap['时长']] = typeof video.duration === 'number' ? Math.round(video.duration / 1000) : 0; // 毫秒转秒
            if (fieldMap['下载链接']) fields[fieldMap['下载链接']] = String(video.play_addr || '');
            if (fieldMap['音频链接']) fields[fieldMap['音频链接']] = String(video.audio_addr || '');
            if (fieldMap['分享数']) fields[fieldMap['分享数']] = typeof video.share_count === 'number' ? video.share_count : 0;

            // --- 处理文案字段 ---
            // 需要先扩展 Video 接口以包含文案字段
            const videoWithText = video as any; // 临时类型转换
            if (fieldMap['文案']) {
                // 优先使用整理后文案，其次使用原始文案
                const textContent = videoWithText.video_text_arr || videoWithText.video_text_ori || '';
                fields[fieldMap['文案']] = String(textContent);
                if (textContent) {
                    logger(`视频 ${video.aweme_id} 包含文案数据: ${textContent.substring(0, 50)}...`);
                }
            }

            // --- **核心去重逻辑：检查视频编号是否存在** ---
            // 只有在成功获取到视频编号的情况下才进行检查
            if (hasRequiredId) {
                // **关键步骤：清理当前视频的 aweme_id**
                // 同样进行 trim() 和 toLowerCase() 处理，以匹配 Map 中的 key
                const videoId = String(video.aweme_id).trim().toLowerCase();
                // 在 existingVideoIds Map 中查找清理后的 videoId
                const existingRecordId = existingVideoIds.get(videoId);

                // 如果找到了 existingRecordId，说明记录已存在
                if (existingRecordId) {
                    // logger(`视频 ${videoId} 已存在，准备更新 Record ID: ${existingRecordId}`); // 可选调试日志
                    // 将记录添加到待更新列表，包含记录 ID 和新的字段数据
                    recordsToUpdate.push({ recordId: existingRecordId, fields });
                }
                // 如果没有找到 existingRecordId，说明是新记录
                else {
                    // logger(`视频 ${videoId} 不存在，准备新增`); // 可选调试日志
                    // 将记录添加到待新增列表，只包含字段数据
                    recordsToAdd.push({ fields });
                    logger(`准备新增记录 (视频编号: ${video.aweme_id})`); // 日志中使用原始 ID
                }
            }
          } // 结束遍历 API 返回的视频数据

          // --- 批量写入/更新表格 ---

          // 批量添加新记录
          if (recordsToAdd.length > 0) {
            logger(`正在批量添加 ${recordsToAdd.length} 条新记录...`);
            try {
              // 设置每批次的大小 (飞书 API 通常限制 500 或 1000，保守起见用 500)
              const batchSize = 500;
              // 分批次添加记录
              for (let i = 0; i < recordsToAdd.length; i += batchSize) {
                  const batch = recordsToAdd.slice(i, i + batchSize); // 获取当前批次的数据
                  await table.addRecords(batch); // 调用 SDK 批量添加
                  logger(`成功添加 ${i + batch.length}/${recordsToAdd.length} 条新记录`);
              }
              logger(`${recordsToAdd.length} 条新记录添加成功`);
            } catch (addError) {
              logger(`批量添加记录失败: ${addError}`);
              // 可以在这里添加更详细的错误处理，例如记录失败的批次数据
            }
          } else {
            logger("没有需要添加的新记录");
          }

          // 批量更新现有记录
          if (recordsToUpdate.length > 0) {
            logger(`正在批量更新 ${recordsToUpdate.length} 条现有记录...`);
            try {
              // 设置每批次的大小
              const batchSize = 500;
              // 分批次更新记录
               for (let i = 0; i < recordsToUpdate.length; i += batchSize) {
                  const batch = recordsToUpdate.slice(i, i + batchSize); // 获取当前批次的数据
                  await table.setRecords(batch); // 调用 SDK 批量更新
                  logger(`成功更新 ${i + batch.length}/${recordsToUpdate.length} 条记录`);
              }
              logger(`${recordsToUpdate.length} 条记录更新成功`);
            } catch (updateError) {
              logger(`批量更新记录失败: ${updateError}`);
              // 可以在这里添加更详细的错误处理
            }
          } else {
            logger("没有需要更新的现有记录");
          }

        } else {
          // API 返回了 videos 数组，但数组为空
          logger('API 返回了空的数据列表');
        }
      } else {
        // API 响应格式不正确，或未包含 videos 字段
        logger(`获取数据失败或响应格式不正确: ${response.data?.message || response.data?.detail || '未知错误'}`);
      }
    } catch (error) { // 捕获处理单个 URL 过程中的所有错误
      logger(`处理链接 ${singleUrl} 时发生错误: ${error}`);
      // 特别处理 Axios 错误，提供更具体的网络或状态码信息
      if (axios.isAxiosError(error)) {
        const errorDetail = error.response?.data?.detail || JSON.stringify(error.response?.data) || error.message;
        logger(`Axios 错误详情: ${error.response?.status} - ${errorDetail}`);
      }
    }
  } // 结束遍历输入的 URL

  logger('所有链接处理完毕');
} 