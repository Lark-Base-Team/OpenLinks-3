import React, { useEffect, useState, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { bitable, FieldType, IRecord, IFieldMeta } from '@lark-base-open/js-sdk';
import { Alert, AlertProps, Button, Select, Input, InputNumber, Card, Space } from 'antd';
import { getVideosData } from './utils/get_videosdata';
import * as XLSX from 'xlsx';
import axios from 'axios';
import pLimit from 'p-limit';
import { Toaster, toast } from 'sonner';
import { submitAsrTasks, pollAsrResults, submitLlmTasks, pollLlmResults } from './utils/get_videostext';
import './styles/form.css';

const { Option } = Select;

export const API_BASE_URL = 'https://www.ccai.fun';

// 定义表格项的接口
interface TableItem {
  value: string;
  label: string;
}

// 定义视频处理过程中的数据结构
export interface ProcessingVideo {
  recordId: string; // 飞书表格记录 ID
  aweme_id: string; // 视频编号
  play_addr?: string | null;
  audio_addr?: string | null;
  duration?: number;
  video_text_ori?: string | null; // 原始文案
  video_text_arr?: string | null; // 整理后文案
  asr_task_id?: string | null;    // ASR 任务 ID
  llm_task_id_list?: { conversation_id: string; chat_id: string }[] | null; // LLM 任务 ID 列表
  status: 'pending' | 'asr_posting' | 'asr_polling' | 'asr_done' | 'llm_posting' | 'llm_polling' | 'llm_done' | 'completed' | 'failed';
  error?: string | null; // 错误信息
}

// 定义 API 响应结构 (根据后端调整)
export interface VideoTextApiResponse {
    message: string;
    videotext: { // 注意后端返回的是 videotext 对象
        aweme_id: string;
        play_addr?: string | null;
        audio_addr?: string | null;
        video_text_ori?: string | null;
        video_text_arr?: string | null;
        asr_task_id?: string | null;
        llm_task_id_list?: { conversation_id: string; chat_id: string }[] | null;
    };
    bonus_points_balance?: number | null;
    recent_deducted_points?: number | null;
}

// 定义 EXIST 标记 (与后端 handlers.py 保持一致)
const ASR_TASK_EXIST_MARKER = "EXIST";
const LLM_TASK_EXIST_MARKER = [{ conversation_id: "EXIST", chat_id: "EXIST" }];

// 辅助函数判断是否为 LLM EXIST 标记
function isLlmTaskExistMarker(list: any): boolean {
  return Array.isArray(list) && list.length === 1 && list[0]?.conversation_id === "EXIST";
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('找不到 root 元素');

// 只初始化一次 root
const root = ReactDOM.createRoot(rootElement); 

root.render(
  <React.StrictMode>
    <LoadApp/>
  </React.StrictMode>
);

/**
 * 主应用组件，负责：
 * 1. 初始化SDK并获取当前表格信息
 * 2. 处理用户输入和API请求
 * 3. 将数据写入多维表格
 */
function LoadApp() {
  // 状态：用于显示表格信息
  const [info, setInfo] = useState('获取表格名称中，请稍候...');
  const [alertType, setAlertType] = useState<AlertProps['type']>('info');

  // 用户认证状态
  const [username, setUsername] = useState('');
  const [passtoken, setPasstoken] = useState('');

  // 添加积分相关状态
  const [bonusPointsBalance, setBonusPointsBalance] = useState(0);
  const [recentDeductedPoints, setRecentDeductedPoints] = useState(0);

  // 平台配置
  const [platform, setPlatform] = useState('douyin');
  const [linkType, setLinkType] = useState('homepage');
  const [updateMethod, setUpdateMethod] = useState('update');
  const [pageCount, setPageCount] = useState(1);

  // URL输入
  const [url, setUrl] = useState('');
  
  // 当前表格和选中记录
  const [currentTable, setCurrentTable] = useState<any>(null);
  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [fieldMap, setFieldMap] = useState<Record<string, string>>({});
  
  // 按钮状态
  const [textButtonText, setTextButtonText] = useState('开始获取文案');
  const [textButtonDisabled, setTextButtonDisabled] = useState(false);

  // 添加下载按钮状态
  const [downloadButtonDisabled, setDownloadButtonDisabled] = useState(false);

  // 在LoadApp组件中添加新的状态
  const [excelButtonDisabled, setExcelButtonDisabled] = useState(false);

  // 在状态定义部分
  const [updateScope, setUpdateScope] = useState<'latest' | 'all'>('latest');

  // 在状态定义部分添加新状态
  // 测试环境使用秒
  const [intervalHours, setIntervalHours] = useState(12); // 单位：小时（原为秒）
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [countdown, setCountdown] = useState(0); // 初始化为0

  // 在状态定义部分添加新状态
  const [botWebURL, setBotWebURL] = useState('https://open.feishu.cn/open-apis/bot/v2/hook/2c433239-cc8f-471a-8457-052e9b3a1c99'); // 新增订阅地址状态，设置默认值
  const [subscriptionTimer, setSubscriptionTimer] = useState<NodeJS.Timeout | null>(null); // 用于存储定时器引用

  // 在状态定义部分添加新状态
  const [templateId, setTemplateId] = useState('AAqReM3nWGMWd'); // 飞书模板ID，设置默认值
  const [templateVersionName, setTemplateVersionName] = useState('1.0.2'); // 模板版本号，设置默认值

  // 1. 定义ref
  const subRef = useRef(false);

  // 初始化：组件加载时获取表格信息
  useEffect(() => {
    const fn = async () => {
      console.info('获取活动表格...');
      const table = await bitable.base.getActiveTable();
      setCurrentTable(table);
      
      const tableName = await table.getName();
      console.info(`获取到表格名称: ${tableName}`);
      setInfo(`当前表格名称: ${tableName}`);
      setAlertType('success');
      
      // 获取字段映射
      const fields = await table.getFieldMetaList();
      const fieldMapObj: Record<string, string> = {};
      fields.forEach((field: any) => {
        fieldMapObj[field.name] = field.id;
      });
      setFieldMap(fieldMapObj);
      
      // 获取选中的记录
      try {
        // 使用 table.getSelection() 获取当前选择
        const selection = await bitable.base.getSelection();
        if (selection && selection.recordId) {
          setSelectedRecords([selection.recordId]);
        }
      } catch (error) {
        console.error('获取选中记录失败:', error);
      }
      
      // 监听选择变化
      bitable.base.onSelectionChange(({ data }) => {
        if (data && data.recordId) {
          setSelectedRecords([data.recordId]);
        } else {
          setSelectedRecords([]);
        }
      });
    };
    fn();
  }, []);

  // 添加状态监听
  useEffect(() => {
    console.log('订阅状态变化:', subRef.current);
  }, [isSubscribed]);

  
  // 简化倒计时效果（仅UI）
  useEffect(() => {
    if (!isSubscribed || countdown <= 0) return;
    
    const timer = setInterval(() => {
      setCountdown(prev => (prev > 0 ? prev - 1 : 0)); // 确保不小于0
    }, 1000);
    
    return () => clearInterval(timer);
  }, [isSubscribed, countdown]);

  
  // 新增格式化函数
  const formatCountdown = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}小时${m}分${s}秒`;
  };


  // 获取用户信息函数
  const getUserInfo = async () => {
    try {
      console.log('正在获取用户积分信息...');
      
      if (!username || !passtoken) {
        console.log('请输入用户名和密码');
        toast.error('请输入用户名和密码');
        return;
      }
      
      const data = {
        username: username,
        passtoken: passtoken
      };

      const endpoint = '/api/user/getUserInfo';
      const requestUrl = `${API_BASE_URL}${endpoint}`;

      console.log(`发送请求到: ${requestUrl}\n请求数据:\n${JSON.stringify(data, null, 2)}`);
      console.log('开始发送请求...');
      const response = await axios.post(requestUrl, data);

      console.log('开始解析响应数据...');
      const responseData = response.data;
      console.log(`收到响应:\n${JSON.stringify(responseData, null, 2)}`);
      
      // 更新积分信息
      setBonusPointsBalance(responseData.bonus_points_balance || 0);
      setRecentDeductedPoints(responseData.recent_deducted_points || 0);
      
      console.log(`用户积分信息获取成功!\n积分余额: ${responseData.bonus_points_balance}\n最新消耗: ${responseData.recent_deducted_points}`);
    } catch (error) {
      console.error('获取用户信息失败:', error);
      if (axios.isAxiosError(error)) {
          const errorDetail = error.response?.data?.detail || error.message;
          console.log(`获取用户信息失败: ${errorDetail}`);
          toast.error(`获取用户信息失败: ${errorDetail}`);
      } else if (error instanceof Error && error.message.includes('Network Error')) {
         console.log(`获取用户信息失败: 网络错误。请检查后端服务器 (${API_BASE_URL}) 是否配置了正确的 CORS 策略以允许来自飞书域名的访问。`);
         toast.error('获取用户信息失败: 网络错误或 CORS 配置问题');
      } else {
         console.log(`获取用户信息失败: ${error instanceof Error ? error.message : String(error)}`);
         toast.error(`获取用户信息失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  // 开始获取数据
  const startFetch = async () => {
    await getVideosData(
      username,
      passtoken,
      platform,
      linkType,
      updateMethod,
      pageCount,
      url,
      console.log
    );
  };
  

  // 下载视频文案函数
  const downloadtxt = async () => {
    try {
      setDownloadButtonDisabled(true);
      console.log('开始准备下载视频文案...');
      
      // 1. 获取当前表格
      const selection = await bitable.base.getSelection();
      if (!selection || !selection.tableId) {
        console.log('请先选择一个表格');
        setDownloadButtonDisabled(false);
        return;
      }
      
      const table = await bitable.base.getTableById(selection.tableId);
      const tableName = await table.getName();
      console.log(`当前表格: ${tableName}`);
      
      // 2. 获取字段信息
      const fields = await table.getFieldMetaList();
      
      // 查找必要字段
      const textField = fields.find(field => field.name === '文案');
      const nicknameField = fields.find(field => field.name === '昵称');
      const createTimeField = fields.find(field => field.name === '发布日期');
      const descField = fields.find(field => field.name === '描述');
      const diggCountField = fields.find(field => field.name === '点赞数');
      const commentCountField = fields.find(field => field.name === '评论数');
      const collectCountField = fields.find(field => field.name === '收藏数');
      const shareCountField = fields.find(field => field.name === '分享数');
      const shareUrlField = fields.find(field => field.name === '分享链接');
      
      if (!textField) {
        console.log('缺少必要字段"文案"，请确保表格中有该字段');
        setDownloadButtonDisabled(false);
        return;
      }
      
      // 3. 获取所有记录ID
      const recordIdList = await table.getRecordIdList();
      console.log(`获取到 ${recordIdList.length} 条记录`);
      
      // 4. 处理每条记录并生成文件
      let successCount = 0;
      
      for (const recordId of recordIdList) {
        try {
          // 获取文案，如果为空则赋空值
          const textValue = await table.getCellString(textField.id, recordId) || '';
          
          // 获取其他字段值
          const nickname = nicknameField ? await table.getCellString(nicknameField.id, recordId) || '未知作者' : '未知作者';
          const createTime = createTimeField ? await table.getCellString(createTimeField.id, recordId) || '未知时间' : '未知时间';
          const desc = descField ? await table.getCellString(descField.id, recordId) || '' : '';
          const diggCount = diggCountField ? await table.getCellValue(diggCountField.id, recordId) || 0 : 0;
          const commentCount = commentCountField ? await table.getCellValue(commentCountField.id, recordId) || 0 : 0;
          const collectCount = collectCountField ? await table.getCellValue(collectCountField.id, recordId) || 0 : 0;
          const shareCount = shareCountField ? await table.getCellValue(shareCountField.id, recordId) || 0 : 0;
          const shareUrl = shareUrlField ? await table.getCellString(shareUrlField.id, recordId) || '' : '';
          
          // 构建文件名
          // 格式: "昵称_发布日期_点赞数_评论数_描述.txt"
          const createTimeShort = createTime.replace(/[^0-9]/g, '').substring(0, 8); // 提取日期数字部分
          const shortDesc = desc.length > 50 ? desc.substring(0, 50) : desc; // 截取描述前50个字符
          const sanitizedDesc = shortDesc.replace(/[\\/:*?"<>|]/g, '_'); // 移除文件名中不允许的字符
          
          const fileName = `${nickname}_${createTimeShort}_digg${diggCount}_comt${commentCount}_${sanitizedDesc}.txt`;
          
          // 构建文件内容
          const content = 
            `作者: ${nickname}\n` +
            `发布时间: ${createTime}\n` +
            `点赞数: ${diggCount}\n` +
            `评论数: ${commentCount}\n` +
            `收藏数: ${collectCount}\n` +
            `分享数: ${shareCount}\n\n` +
            `视频标题:\n${desc}\n\n` +
            `视频文案:\n${textValue}\n\n` +
            `视频链接:\n${shareUrl}`;
          
          // 下载文件
          const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = fileName;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
          
          successCount++;
          console.log(`成功生成文件: ${fileName}`);
          
          // 每个文件下载后稍微延迟，避免浏览器阻止多个下载
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
          console.log(`处理记录 ${recordId} 时出错: ${error}`);
        }
      }
      
      if (successCount === 0) {
        console.log('没有找到有效的文案记录');
      } else {
        console.log(`成功生成 ${successCount} 个文案文件`);
      }
    } catch (error) {
      console.error('下载文案失败:', error);
      console.log(`下载文案失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDownloadButtonDisabled(false);
    }
  };

  // 下载表格数据函数
  const downloadexcel = async () => {
    try {
      setExcelButtonDisabled(true);
      console.log('开始准备下载表格数据...');

      // 1. 获取当前表格
      const selection = await bitable.base.getSelection();
      if (!selection || !selection.tableId) {
        console.log('请先选择一个表格');
        setExcelButtonDisabled(false);
        return;
      }

      const table = await bitable.base.getTableById(selection.tableId);
      const tableName = await table.getName();
      console.log(`当前表格: ${tableName}`);

      // 2. 获取字段信息
      const fields = await table.getFieldMetaList();

      // 查找必要字段 (确保查找所有表头对应的字段)
      const videoIdField = (await table.getFieldMetaList())
        .find((field: IFieldMeta) => field.name === '视频编号');
      const nicknameField = fields.find(field => field.name === '昵称');
      const createTimeField = fields.find(field => field.name === '发布日期');
      const descField = fields.find(field => field.name === '描述');
      const diggCountField = fields.find(field => field.name === '点赞数');
      const commentCountField = fields.find(field => field.name === '评论数');
      const collectCountField = fields.find(field => field.name === '收藏数');
      const shareCountField = fields.find(field => field.name === '分享数');
      // --- 新增查找 ---
      const durationField = fields.find(field => field.name === '时长');
      const shareUrlField = fields.find(field => field.name === '分享链接'); // 查找 '分享链接'
      const downloadLinkField = fields.find(field => field.name === '下载链接');
      const audioLinkField = fields.find(field => field.name === '音频链接');
      // --- 结束新增查找 ---
      const textField = fields.find(field => field.name === '文案');


      // 3. 获取所有记录ID
      const recordIdList = await table.getRecordIdList();
      console.log(`获取到 ${recordIdList.length} 条记录`);

      // 4. 准备Excel数据
      const data = [];

      // 添加表头 (与你的修改保持一致)
      data.push([
        '视频编号', '昵称', '发布日期', '描述', '点赞数', '评论数', '收藏数', '分享数', '时长',
        '分享链接', '下载链接', '音频链接', '文案'
      ]);

      // 处理每条记录
      for (const recordId of recordIdList) {
        try {
          // --- 修改：按照表头顺序获取单元格数据 ---
          const rowData = await Promise.all([
            videoIdField ? table.getCellString(videoIdField.id, recordId) : '',
            nicknameField ? table.getCellString(nicknameField.id, recordId) : '',
            createTimeField ? table.getCellString(createTimeField.id, recordId) : '',
            descField ? table.getCellString(descField.id, recordId) : '',
            diggCountField ? table.getCellString(diggCountField.id, recordId) : '',
            commentCountField ? table.getCellString(commentCountField.id, recordId) : '',
            collectCountField ? table.getCellString(collectCountField.id, recordId) : '',
            shareCountField ? table.getCellString(shareCountField.id, recordId) : '',
            durationField ? table.getCellString(durationField.id, recordId) : '', // 获取时长
            shareUrlField ? table.getCellString(shareUrlField.id, recordId) : '', // 获取分享链接
            downloadLinkField ? table.getCellString(downloadLinkField.id, recordId) : '', // 获取下载链接
            audioLinkField ? table.getCellString(audioLinkField.id, recordId) : '', // 获取音频链接
            textField ? table.getCellString(textField.id, recordId) : '' // 获取文案
          ]);
          data.push(rowData);
          // --- 结束修改 ---
        } catch (error) {
          console.error(`处理记录 ${recordId} 失败:`, error);
          // 可以选择跳过此记录或添加一行错误提示
          data.push([`错误: 处理记录 ${recordId} 失败`]);
        }
      }
      
      // 5. 生成Excel文件
      const worksheet = XLSX.utils.aoa_to_sheet(data);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
      
      // 6. 生成文件名
      const now = new Date();
      const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
      const fileName = `视频数据_${dateStr}_${timeStr}.xlsx`;
      
      // 7. 下载文件
      XLSX.writeFile(workbook, fileName);
      
      console.log(`成功生成Excel文件: ${fileName}`);
    } catch (error) {
      console.error('下载表格数据失败:', error);
      console.log(`下载表格数据失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExcelButtonDisabled(false);
    }
  };

  const startMultiHandleVideoText = async () => {
    // 1. 初始化状态
    setTextButtonDisabled(true);
    setTextButtonText('准备多表处理...');

    try {
      // 2. 获取所有表格
      const tables = await bitable.base.getTableList();
      let successCount = 0;

      // 3. 遍历处理每个表格
      for (const table of tables) {
        try {
          // 3.1 获取并显示当前表格名称
          const tableName = await table.getName();
          toast.info(`正在处理表格: ${tableName}`);   // 在前端显示当前处理的表名
          setTextButtonText(`处理表: ${tableName}`);
          
          // 3.2 执行文案获取流程
          await handleVideoText(table);
          successCount++;
        } catch (error) {
          console.error(`表处理失败: ${error}`);
        }
      }

      // 4. 显示最终结果
      toast.success(`完成多表处理 (${successCount}/${tables.length})`);
    } finally {
      // 重置状态
      setTextButtonDisabled(false);
      setTextButtonText('开始获取文案');
    }
  };

  // 开始获取文案
  const handleVideoText = async (targetTable?: any) => {
    console.log('开始获取文案流程...');
    setTextButtonDisabled(true);
    setTextButtonText('准备中...');

    // 1. 验证用户凭据
    if (!username || !passtoken) {
      console.error('错误：用户名和密码不能为空');
      toast.error('请输入用户名和密码');
      setTextButtonDisabled(false);
      setTextButtonText('开始获取文案');
      return;
    }

    let processingVideos: ProcessingVideo[] = [];
    let table: any = null;
    let textFieldId: string | undefined = undefined;

    try {
      // 2. 获取表格和字段信息
      const selection = await bitable.base.getSelection();
      if (!selection || !selection.tableId) {
        console.log('请先选择一个表格');
        toast.info('请先选择一个表格');
        setTextButtonDisabled(false);
        setTextButtonText('开始获取文案');
        return;
      }

      table = targetTable || await bitable.base.getTableById(selection.tableId);
      const tableName = await table.getName();
      console.log(`当前表格: ${tableName}`);

      const fields = await table.getFieldMetaList();
      const textField = fields.find((field: IFieldMeta) => field.name === '文案');
      const videoIdField = fields.find((field: IFieldMeta) => field.name === '视频编号');
      const playAddrField = fields.find((field: IFieldMeta) => field.name === '下载链接');
      const audioAddrField = fields.find((field: IFieldMeta) => field.name === '音频链接');
      const durationField = fields.find((field: IFieldMeta) => field.name === '时长');

      if (!textField || !videoIdField) {
        const missingFields = [
          !textField ? '文案' : '',
          !videoIdField ? '视频编号' : ''
        ].filter(Boolean).join('、');
        toast.error(`表【${tableName}】缺少必需字段: ${missingFields}`);
        return;
      }
      textFieldId = textField.id;

      // 3. 获取需要处理的记录
      const recordIdList = await table.getRecordIdList();
      const recordsToFetchDetails: string[] = [];
      for (const recordId of recordIdList) {
        try {
          const textValue = await table.getCellValue(textField.id, recordId);
          if (!textValue) recordsToFetchDetails.push(recordId);
        } catch (error) {
          console.warn(`检查记录 ${recordId} 文案字段时出错: ${error}`);
        }
      }

      if (recordsToFetchDetails.length === 0) {
        console.log('没有找到"文案"字段为空的记录');
        toast.info('没有需要处理的记录（"文案"字段均不为空）');
        setTextButtonDisabled(false);
        setTextButtonText('开始获取文案');
        return;
      }

      // 4. 获取记录的详细信息
      for (const recordId of recordsToFetchDetails) {
        try {
          const videoIdValue = await table.getCellString(videoIdField.id, recordId);
          if (!videoIdValue) continue;
          const playAddr = playAddrField ? await table.getCellString(playAddrField.id, recordId) : null;
          const audioAddr = audioAddrField ? await table.getCellString(audioAddrField.id, recordId) : null;
          const durationValue = durationField ? await table.getCellValue(durationField.id, recordId) : null;
          const duration = typeof durationValue === 'number' ? durationValue : undefined;

          processingVideos.push({
            recordId: recordId,
            aweme_id: videoIdValue,
            play_addr: playAddr,
            audio_addr: audioAddr,
            duration: duration,
            status: 'pending',
          });
        } catch (error) {
          console.error(`获取记录 ${recordId} 详细信息时出错: ${error}`);
        }
      }

      if (processingVideos.length === 0) {
        console.log('筛选后没有有效的视频记录需要处理');
        toast.info('筛选后没有有效的视频记录需要处理');
        setTextButtonDisabled(false);
        setTextButtonText('开始获取文案');
        return;
      }

      const totalVideosToProcess = processingVideos.length;
      console.log(`最终确定 ${totalVideosToProcess} 个视频需要处理文案`);

      // 5. 调用分拆后的4阶段函数
      // 阶段1: 提交ASR任务
      await submitAsrTasks(
        processingVideos,
        username,
        passtoken,
        (count, total) => setTextButtonText(`提交ASR ${count}/${total}`)
      );

      // 阶段2: 轮询ASR结果
      await pollAsrResults(
        processingVideos,
        username,
        passtoken,
        (completed, total, attempt) => setTextButtonText(`查询ASR ${completed}/${total} (第 ${attempt}轮)`)
      );

      // 阶段3: 提交LLM任务
      await submitLlmTasks(
        processingVideos,
        username,
        passtoken,
        (count, total) => setTextButtonText(`提交LLM ${count}/${total}`)
      );

      // 阶段4: 轮询LLM结果
      await pollLlmResults(
        processingVideos,
        username,
        passtoken,
        (completed, total, attempt) => setTextButtonText(`查询LLM ${completed}/${total} (第 ${attempt}轮)`)
      );

      // 6. 统一更新表格
      setTextButtonText('更新表格...');
      const recordsToUpdate: { recordId: string; fields: { [fieldId: string]: any } }[] = [];
      let updateCount = 0;
      let failCount = 0;

      for (const video of processingVideos) {
        if (video.status === 'llm_done' || (video.status === 'asr_done' && !video.llm_task_id_list)) {
          const finalText = video.video_text_arr || video.video_text_ori;
          if (finalText && video.recordId && textFieldId) {
            recordsToUpdate.push({
              recordId: video.recordId,
              fields: { [textFieldId]: finalText }
            });
          } else {
            failCount++;
          }
        } else if (video.status === 'failed') {
          failCount++;
        } else {
          failCount++;
        }
      }

      if (recordsToUpdate.length > 0) {
        try {
          await table.setRecords(recordsToUpdate);
          updateCount = recordsToUpdate.length;
        } catch (error) {
          console.error(`批量更新表格失败: ${error}`);
          toast.error(`批量更新表格失败: ${error}`);
          for (const record of recordsToUpdate) {
            try {
              await table.setRecord(record.recordId, record);
              updateCount++;
            } catch (singleError) {
              console.error(`更新记录 ${record.recordId} 失败: ${singleError}`);
            }
          }
        }
      }

      console.log(`文案处理流程结束。成功: ${updateCount}, 失败: ${failCount}`);
      toast.success(`处理完成！成功: ${updateCount}, 失败: ${failCount}`);

    } catch (error: any) {
      console.error('处理文案流程发生严重错误:', error);
      toast.error(`处理失败: ${error.message || String(error)}`);
    } finally {
      setTextButtonDisabled(false);
      setTextButtonText('开始获取文案');
    }
  };

  /**
   * 博主订阅主函数
   * 功能：启动定时订阅服务，定期获取并处理视频数据
   */
  const bloggersSubscribe = async () => {
    if (!botWebURL || !username || !passtoken) return;

    subRef.current = true;
    setIsSubscribed(true);
    setCountdown(intervalHours * 3600);
    toast.success('订阅服务已启动');

    try {
      while (subRef.current) {
        setCountdown(intervalHours * 3600);
        toast.info('🔄 开始执行订阅任务循环...');
        console.log('🔄 开始执行订阅任务循环...');
        
        // 执行任务（不 await，避免阻塞循环）
        void executeSubscriptionTask();
        
        // 等待周期（不受任务影响）
        await new Promise(resolve => {
          const intervalId = setInterval(() => {
            if (!subRef.current) {
              clearInterval(intervalId);
              resolve(null);
            }
          }, 5000);

          setTimeout(() => {
            clearInterval(intervalId);
            resolve(null);
          }, intervalHours * 3600 * 1000);
        });
      }
    } finally {
      console.log('⏹️ 订阅流程结束');
    }
  };

  const executeSubscriptionTask = async (): Promise<void> => {
    try {
      console.log('【任务开始】获取所有表格数据...');
      
      // 1. 获取所有表格
      const tables = await bitable.base.getTableList();
      const allInitialRecords: Map<string, string[]> = new Map(); // 表ID -> 初始记录ID列表

      // 2. 初始化记录快照（所有表格）
      for (const table of tables) {
        const tableId = table.id;
        const records = await table.getRecordIdList();
        allInitialRecords.set(tableId, records);
        console.log(`📊 表 ${tableId} 初始记录数: ${records.length}`);
      }

      // 3. 执行全表数据获取和文案处理
      await getVideosData(
        username,
        passtoken,
        platform,
        linkType,
        updateMethod,
        pageCount,
        url,
        console.log
      );
      await startMultiHandleVideoText(); // 替换原 handleVideoText()

      // 4. 检测所有表格的新增记录
      const allNewRecords: { tableId: string; awemeIds: string[] }[] = [];
      
      for (const table of tables) {
        const tableId = table.id;
        const initialRecords = allInitialRecords.get(tableId) || [];
        const currentRecords = await table.getRecordIdList();
        const newRecordIds = currentRecords.filter(id => !initialRecords.includes(id));

        if (newRecordIds.length > 0) {
          const videoIdField = (await table.getFieldMetaList()).find(f => f.name === '视频编号');
          if (videoIdField) {
            const awemeIds = await Promise.all(
              newRecordIds.map(async id => {
                const awemeId = await table.getCellString(videoIdField.id, id);
                return awemeId?.trim() || null;
              })
            ).then(res => res.filter(Boolean) as string[]);
            
            allNewRecords.push({ tableId, awemeIds });
          }
        }
      }

      // 5. 发送订阅消息（整合所有新增视频）
      if (allNewRecords.length > 0) {
        const allAwemeIds = allNewRecords.flatMap(r => r.awemeIds);
        toast.success(`发现 ${allNewRecords.length} 个表格有新增记录，共 ${allAwemeIds.length} 条视频，已发送通知消息...`);
        console.log(`✅ 发现新增记录: ${allNewRecords.length} 个表格, ${allAwemeIds.length} 条视频`);
        
        await axios.post(`${API_BASE_URL}/api/video/subscribe-message`, {
          username,
          passtoken,
          botWebURL,
          template_id: templateId,
          template_version_name: templateVersionName,
          aweme_ids: allAwemeIds
        });
      const currentTime = new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      toast.success(`新增记录通知发送完毕 (${currentTime})`);
      console.log(`新增记录通知发送完毕 (${currentTime})`);
      toast.info(`订阅任务执行完成，等待执行下一次订阅任务... (${intervalHours}小时后)`);
      console.log(`订阅任务执行完成，等待执行下一次订阅任务... (${intervalHours}小时后)`);
      }
    } catch (error) {
      console.error('❌ 全表订阅任务失败:', error);
    }
  };

  // 3. 修改取消函数
  const cancelSubscription = () => {
    if (!subRef.current) {
      console.log('取消请求: 订阅已处于取消状态');
      return;
    }
    
    console.log('执行取消操作...');
    subRef.current = false;
    setIsSubscribed(false);
    setCountdown(0);
    
    // 强制清除可能存在的定时器
    if (subscriptionTimer) {
      clearInterval(subscriptionTimer);
      setSubscriptionTimer(null);
    }
    
    toast.success('已取消订阅');
    console.log('取消操作完成，当前状态:', subRef.current);
  };



  return (
    <div style={{ padding: '16px' }}>
      <Toaster position="top-center" richColors />
      <Alert message={info} type={alertType} style={{ marginBottom: '16px' }} />
      
      <div style={{ padding: '0 16px' }}>
        <div className="form-item">
          <span className="form-label">用户名</span>
          <Input className="form-input" 
            placeholder="请输入用户名" 
            value={username} 
            onChange={e => setUsername(e.target.value)} 
            disabled={isSubscribed}
          />
        </div>
        
        <div className="form-item">
          <span className="form-label">密码</span>
          <Input.Password className="form-input" 
            placeholder="请输入密码" 
            value={passtoken} 
            onChange={e => setPasstoken(e.target.value)} 
            disabled={isSubscribed}
          />
        </div>
        
        <div style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', marginBottom: '4px' }}>
            <div style={{ display: 'flex', flex: 1, justifyContent: 'flex-start' }}>
              <span style={{ fontSize: '14px', color: '#333' }}>积分余额:</span>
              <span style={{ fontSize: '14px', color: '#333', marginLeft: '6px' }}>{bonusPointsBalance}</span>
            </div>
            <div style={{ display: 'flex', flex: 1, justifyContent: 'center' }}>
              <span style={{ fontSize: '14px', color: '#333' }}>最近消耗:</span>
              <span style={{ fontSize: '14px', color: '#333', marginLeft: '6px' }}>{recentDeductedPoints}</span>
            </div>
            <div style={{ display: 'flex', flex: 1, justifyContent: 'flex-end' }}>
              <a 
                href="https://www.ccai.fun/app" 
                target="_blank" 
                rel="noopener noreferrer"
                style={{ fontSize: '14px', color: '#1890ff' }}
              >
                注册/充值
              </a>
            </div>
          </div>
          <Button 
            type="primary" 
            onClick={getUserInfo}
            disabled={isSubscribed}
            style={{ width: '100%', marginTop: '4px' }}
          >
            更新积分
          </Button>
        </div>
        
        <div className="form-item">
          <span className="form-label">所属平台</span>
          <Select className="form-input" 
            value={platform} 
            onChange={value => setPlatform(value)}
            disabled={isSubscribed}
          >
            <Option value="douyin">抖音</Option>
            <Option value="tiktok">TikTok</Option>
          </Select>
        </div>
        
        <div className="form-item">
          <span className="form-label">链接类型</span>
          <Select className="form-input" 
            value={linkType} 
            onChange={value => setLinkType(value)}
            disabled={isSubscribed}
          >
            <Option value="homepage">主页链接</Option>
            <Option value="videourl">视频链接</Option>
          </Select>
        </div>
        
        <div className="form-item">
          <span className="form-label">更新方式</span>
          <Select className="form-input" 
            value={updateMethod} 
            onChange={value => setUpdateMethod(value)}
            disabled={isSubscribed}
          >
            <Option value="extract">提取</Option>
            <Option value="update">更新</Option>
          </Select>
        </div>
        
        <div className="form-item">
          <span className="form-label">更新范围</span>
          <Select className="form-input" 
            value={updateScope}
            onChange={value => {
              setUpdateScope(value);
              setPageCount(value === 'latest' ? 1 : 99);
            }}
            disabled={isSubscribed}
          >
            <Option value="latest">获取最新</Option>
            <Option value="all">更新全部</Option>
          </Select>
        </div>
        
        <div style={{ marginBottom: '16px' }}>
          <div style={{ marginBottom: '8px', fontSize: '14px', color: '#333' }}>输入链接（支持多行粘贴）</div>
          <Input.TextArea className="form-input" 
            placeholder="请输入链接，支持多行粘贴" 
            value={url} 
            onChange={e => setUrl(e.target.value)} 
            disabled={isSubscribed}
            autoSize={{ minRows: 2, maxRows: 6 }}
          />
        </div>
        
        <Space direction="vertical" style={{ width: '100%', marginBottom: '16px' }}>
          <Button 
            type="primary" 
            onClick={startFetch}
            disabled={isSubscribed || textButtonDisabled}
            style={{ width: '100%' }}
          >
            开始获取数据
          </Button>
          
          <Button 
            type="primary" 
            onClick={startMultiHandleVideoText}
            disabled={isSubscribed || textButtonDisabled}
            style={{ width: '100%' }}
          >
            {textButtonText}
          </Button>
          
          <Button 
            type="primary" 
            onClick={downloadtxt}
            disabled={isSubscribed || downloadButtonDisabled}
            style={{ width: '100%' }}
          >
            下载视频文档
          </Button>
          
          <Button 
            type="primary" 
            onClick={downloadexcel}
            disabled={isSubscribed || excelButtonDisabled}
            style={{ width: '100%' }}
          >
            下载表格数据
          </Button>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ marginBottom: '4px', fontSize: '14px', color: '#333' }}>飞书模板ID</div>
            <Input
              className="form-input"
              placeholder="请输入飞书模板ID"
              value={templateId}
              onChange={e => setTemplateId(e.target.value)}
              disabled={isSubscribed}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ marginBottom: '4px', fontSize: '14px', color: '#333' }}>模板版本号</div>
            <Input
              className="form-input"
              placeholder="请输入模板版本号"
              value={templateVersionName}
              onChange={e => setTemplateVersionName(e.target.value)}
              disabled={isSubscribed}
            />
          </div>
        </div>

          {/* 新增订阅地址输入框 */}
          <div className="form-item">
            <span className="form-label">订阅地址</span>
            <Input
              className="form-input"
              placeholder="请输入订阅地址"
              value={botWebURL}
              onChange={e => setBotWebURL(e.target.value)}
              disabled={isSubscribed}
            />
          </div>
          
          {/* 新增订阅频率输入框 */}
          <div className="form-item">
            <span className="form-label">订阅间隔</span>
            <InputNumber 
              min={1}
              max={72} // 最大24小时（原为3600秒）
              addonAfter="小时" // 原为"秒"
              value={intervalHours}
              onChange={value => setIntervalHours(value || 1)}
              disabled={isSubscribed}
              className="form-input"
            />
          </div>
          
          {/* 新增订阅按钮 */}
          <Button 
            type="primary" 
            onClick={bloggersSubscribe}
            disabled={isSubscribed}
            style={{ width: '100%' }}
          >
            {isSubscribed ? 
              `下次运行: ${formatCountdown(countdown)}` : 
              '博主视频订阅'}
          </Button>
          
          {/* 新增取消订阅按钮 */}
          <Button 
            type="primary" 
            onClick={cancelSubscription}
            disabled={false}
            style={{ width: '100%' }}
          >
            取消视频订阅
          </Button>
        </Space>
      </div>
    </div>
  );
}
