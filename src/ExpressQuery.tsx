import React, { useState, useRef, useEffect } from 'react';
import {
  Card, Button, Input, Alert, Table, Drawer, Space, message,
  Popconfirm, Upload, Typography, Tag, Form, FloatButton,
  Select, Modal
} from 'antd';
import type { TableProps, UploadProps } from 'antd';
import {
  FileExcelOutlined, InboxOutlined, SearchOutlined,
  EditOutlined, SaveOutlined, UpOutlined, DownloadOutlined,
  ExclamationCircleOutlined, FilterOutlined
} from '@ant-design/icons';
import * as XLSX from 'xlsx';
import CreateSampleData from './CreateSampleData';

const { Dragger } = Upload;
const { Search } = Input;
const { Title, Text } = Typography;

interface ExpressData {
  key: string;
  trackingNumber: string; // 快递单号
  company: string; // 快递公司
  batchNumber: string; // 快递批次（sheetName）
  type?: string; // 类型（名字错误/正常）
  status?: string; // 状态（滞留仓库/已发出）
  arriveTime?: string; // 到仓时间
  sendTime?: string; // 发出时间
  recipient?: string;
  phone?: string;
  address?: string;
  rowIndex?: number; // 原始行索引
  columnIndex?: number; // 原始列索引
  columnName?: string; // 列名（如：中通、申通等）
  lastUpdated?: number; // 最后更新时间戳
  source?: 'local' | 'excel'; // 数据来源
  [key: string]: any;
}

// IndexedDB 工具类
class ExpressDataDB {
  private dbName = 'ExpressDataDB';
  private version = 1;
  private storeName = 'expressData';
  private db: IDBDatabase | null = null;

  async initDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // 删除旧的对象存储（如果存在）
        if (db.objectStoreNames.contains(this.storeName)) {
          db.deleteObjectStore(this.storeName);
        }
        
        // 创建新的对象存储
        const store = db.createObjectStore(this.storeName, { keyPath: 'trackingNumber' });
        store.createIndex('batchNumber', 'batchNumber', { unique: false });
        store.createIndex('company', 'company', { unique: false });
        store.createIndex('lastUpdated', 'lastUpdated', { unique: false });
      };
    });
  }

  async getAllData(): Promise<ExpressData[]> {
    if (!this.db) await this.initDB();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || []);
    });
  }

  async saveData(data: ExpressData[]): Promise<void> {
    if (!this.db) await this.initDB();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      
      // 为每条数据添加时间戳
      const dataWithTimestamp = data.map(item => ({
        ...item,
        lastUpdated: Date.now(),
        source: item.source || 'excel'
      }));
      
      let completed = 0;
      const total = dataWithTimestamp.length;
      
      if (total === 0) {
        resolve();
        return;
      }
      
      dataWithTimestamp.forEach(item => {
        const request = store.put(item);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          completed++;
          if (completed === total) {
            resolve();
          }
        };
      });
    });
  }

  async getDataByTrackingNumber(trackingNumber: string): Promise<ExpressData | null> {
    if (!this.db) await this.initDB();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(trackingNumber);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  async clearAllData(): Promise<void> {
    if (!this.db) await this.initDB();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.clear();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
}

interface ExpressQueryProps { }

const ExpressQuery: React.FC<ExpressQueryProps> = () => {
  const [data, setData] = useState<ExpressData[]>([]);
  const [filteredData, setFilteredData] = useState<ExpressData[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const [selectedBatch, setSelectedBatch] = useState<string>('全部'); // 批次筛选
  const [selectedCompany, setSelectedCompany] = useState<string>('全部'); // 公司筛选
  const [selectedType, setSelectedType] = useState<string>('全部'); // 类型筛选
  const [selectedStatus, setSelectedStatus] = useState<string>('全部'); // 状态筛选
  const [editingRecord, setEditingRecord] = useState<ExpressData | null>(null);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [showEditButton, setShowEditButton] = useState(false); // 控制编辑按钮显示
  const [form] = Form.useForm();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // IndexedDB 实例
  const dbRef = useRef<ExpressDataDB>(new ExpressDataDB());

  // 数据合并逻辑：优先使用本地数据，Excel数据作为补充
  const mergeDataWithLocal = async (excelData: ExpressData[]): Promise<ExpressData[]> => {
    try {
      // 获取本地所有数据
      const localData = await dbRef.current.getAllData();
      console.log('本地缓存数据:', localData);
      
      // 创建本地数据的映射表（以快递单号为key）
      const localDataMap = new Map<string, ExpressData>();
      localData.forEach(item => {
        localDataMap.set(item.trackingNumber, item);
      });
      
      // 合并数据：本地数据优先，Excel数据补充
      const mergedData: ExpressData[] = [];
      const newExcelData: ExpressData[] = [];
      
      // 处理Excel数据
      excelData.forEach((excelItem, index) => {
        const localItem = localDataMap.get(excelItem.trackingNumber);
        
        if (localItem) {
          // 如果本地有该数据，使用本地数据，但更新key和一些Excel特有的字段
          const merged: ExpressData = {
            ...localItem,
            key: index.toString(),
            batchNumber: excelItem.batchNumber, // 使用Excel的批次信息
            columnName: excelItem.columnName, // 使用Excel的列名信息
            rowIndex: excelItem.rowIndex,
            columnIndex: excelItem.columnIndex,
            originalData: excelItem.originalData,
            // 如果本地数据的这些字段为空，则使用Excel数据补充
            company: localItem.company || excelItem.company,
            type: localItem.type || excelItem.type,
            status: localItem.status || excelItem.status,
            arriveTime: localItem.arriveTime || excelItem.arriveTime,
            sendTime: localItem.sendTime || excelItem.sendTime,
            source: 'local'
          };
          mergedData.push(merged);
          
          // 从本地数据映射中移除已处理的项
          localDataMap.delete(excelItem.trackingNumber);
        } else {
          // 如果本地没有该数据，添加到新数据列表
          const newItem: ExpressData = {
            ...excelItem,
            key: index.toString(),
            source: 'excel',
            lastUpdated: Date.now()
          };
          mergedData.push(newItem);
          newExcelData.push(newItem);
        }
      });
      
      // 添加本地独有的数据（Excel中不存在的）
      let keyCounter = excelData.length;
      localDataMap.forEach(localItem => {
        mergedData.push({
          ...localItem,
          key: keyCounter.toString(),
          source: 'local'
        });
        keyCounter++;
      });
      
      // 保存新的Excel数据到本地
      if (newExcelData.length > 0) {
        await dbRef.current.saveData(newExcelData);
        console.log(`保存了 ${newExcelData.length} 条新数据到本地缓存`);
      }
      
      console.log('合并后的数据:', mergedData);
      return mergedData;
      
    } catch (error) {
      console.error('数据合并失败:', error);
      message.warning('本地缓存读取失败，使用Excel数据');
      
      // 如果合并失败，尝试保存Excel数据并返回
      try {
        await dbRef.current.saveData(excelData);
      } catch (saveError) {
        console.error('保存数据到本地缓存失败:', saveError);
      }
      
      return excelData.map((item, index) => ({
        ...item,
        key: index.toString(),
        source: 'excel',
        lastUpdated: Date.now()
      }));
    }
  };

  // 创建默认数据
  const createDefaultData = (): ExpressData[] => {
    const defaultTrackingNumbers = [
      // 中通快递单号
      { number: '75761365043766', column: '中通', company: '中通' },
      { number: '75761370314853', column: '中通', company: '中通' },
      { number: '75761778084401', column: '中通', company: '中通' },
      { number: '75701252115546', column: '中通', company: '中通' },
      // 申通快递单号
      { number: '77632957076153', column: '申通', company: '申通' },
      { number: '77716951501759', column: '申通', company: '申通' },
      { number: '77718014846666', column: '申通', company: '申通' },
      { number: '77637759935866', column: '申通', company: '申通' },
      // 圆通快递单号
      { number: 'YT894185215852', column: '圆通', company: '圆通' },
      { number: 'YT893990509270', column: '圆通', company: '圆通' },
      { number: 'YT893963976843', column: '圆通', company: '圆通' },
      { number: 'YT894201069876', column: '圆通', company: '圆通' },
      // 韵达快递单号
      { number: '46334069260168', column: '韵达', company: '韵达' },
      { number: '31866359263298', column: '韵达', company: '韵达' },
      { number: '46287276652932', column: '韵达', company: '韵达' },
      { number: '31843064579230', column: '韵达', company: '韵达' },
      // 其他快递单号（无法识别）
      { number: '98574940403', column: '邮政', company: '' },
      { number: '98560526232', column: '邮政', company: '' },
      { number: '98536949291', column: '邮政', company: '' },
      { number: '97296408178', column: '邮政', company: '' },
    ];

    return defaultTrackingNumbers.map((item, index) => ({
      key: index.toString(),
      trackingNumber: item.number,
      company: item.company,
      batchNumber: '示例批次', // 默认批次名
      type: '正常', // 默认类型
      status: '待处理', // 默认状态
      arriveTime: '', // 默认到仓时间为空
      sendTime: '', // 默认发出时间为空
      recipient: '',
      phone: '',
      address: '',
      rowIndex: Math.floor(index / 4) + 1, // 模拟行索引
      columnIndex: index % 4, // 模拟列索引
      columnName: item.column,
      originalData: []
    }));
  };

  // 从public目录读取Excel文件作为默认数据
  const loadDefaultExcelData = async () => {
    try {
      setLoading(true);

      // 从public目录获取Excel文件
      const response = await fetch('/快递数据.xlsx');
      if (!response.ok) {
        throw new Error('无法加载默认Excel文件');
      }

      const arrayBuffer = await response.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });

      console.log('默认Excel工作表列表:', workbook.SheetNames);

      const allProcessedData: ExpressData[] = [];
      let keyCounter = 0;

      // 遍历所有工作表
      workbook.SheetNames.forEach((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        console.log(`处理工作表: ${sheetName}`, worksheet);

        // 将工作表转换为二维数组
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
        console.log(`工作表 ${sheetName} 数据:`, jsonData);

        if (jsonData.length <= 1) {
          console.log(`工作表 ${sheetName} 没有数据或只有表头`);
          return;
        }

        // 获取表头行并找到各列的索引
        const headerRow = jsonData[0] as any[];
        const getColumnIndex = (keywords: string[]) => {
          return headerRow.findIndex((header: any) => {
            if (!header) return false;
            const headerStr = header.toString();
            return keywords.some(keyword => headerStr.includes(keyword));
          });
        };

        const columnIndexes = {
          company: getColumnIndex(['来源公司', '公司']),
          trackingNumber: getColumnIndex(['快递单号', '单号']),
          type: getColumnIndex(['类型']),
          status: getColumnIndex(['状态']),
          arriveTime: getColumnIndex(['到仓时间', '到仓']),
          sendTime: getColumnIndex(['发出时间', '发出']),
          recipient: getColumnIndex(['收件人', '姓名']),
          phone: getColumnIndex(['电话号码', '手机号', '联系电话', '电话']),
          address: getColumnIndex(['家庭住址', '地址', '收货地址'])
        };

        // 遍历所有行和列
        jsonData.forEach((row: any[], rowIndex) => {
          if (Array.isArray(row) && rowIndex > 0) { // 跳过标题行
            // 首先尝试从指定列获取快递单号
            let trackingNumber = '';
            if (columnIndexes.trackingNumber >= 0 && row[columnIndexes.trackingNumber]) {
              trackingNumber = row[columnIndexes.trackingNumber].toString().trim();
            } else {
              // 如果没有找到快递单号列，则遍历所有列寻找快递单号
              row.forEach((cell: any, columnIndex) => {
                if (!trackingNumber) {
                  const cellValue = cell ? cell.toString().trim() : '';
                  if (cellValue &&
                    cellValue.length > 5 &&
                    /^[A-Za-z0-9]+$/.test(cellValue)) {
                    trackingNumber = cellValue;
                  }
                }
              });
            }

            if (trackingNumber) {
              // 获取其他字段的值
              const company = columnIndexes.company >= 0 && row[columnIndexes.company] 
                ? row[columnIndexes.company].toString().trim() 
                : detectExpressCompany(trackingNumber);

              const type = columnIndexes.type >= 0 && row[columnIndexes.type] 
                ? row[columnIndexes.type].toString().trim() 
                : '';

              const status = columnIndexes.status >= 0 && row[columnIndexes.status] 
                ? row[columnIndexes.status].toString().trim() 
                : '';

              const arriveTime = columnIndexes.arriveTime >= 0 && row[columnIndexes.arriveTime] 
                ? row[columnIndexes.arriveTime].toString().trim() 
                : '';

              const sendTime = columnIndexes.sendTime >= 0 && row[columnIndexes.sendTime] 
                ? row[columnIndexes.sendTime].toString().trim() 
                : '';

              const recipient = columnIndexes.recipient >= 0 && row[columnIndexes.recipient] 
                ? row[columnIndexes.recipient].toString().trim() 
                : '';

              const phone = columnIndexes.phone >= 0 && row[columnIndexes.phone] 
                ? row[columnIndexes.phone].toString().trim() 
                : '';

              const address = columnIndexes.address >= 0 && row[columnIndexes.address] 
                ? row[columnIndexes.address].toString().trim() 
                : '';

              // 获取列名（从第一行）
              const columnName = headerRow && headerRow[columnIndexes.trackingNumber >= 0 ? columnIndexes.trackingNumber : 1]
                ? headerRow[columnIndexes.trackingNumber >= 0 ? columnIndexes.trackingNumber : 1].toString()
                : `列${columnIndexes.trackingNumber >= 0 ? columnIndexes.trackingNumber + 1 : 2}`;

              allProcessedData.push({
                key: keyCounter.toString(),
                trackingNumber: trackingNumber,
                company: company,
                batchNumber: sheetName, // 使用sheetName作为批次号
                type: type,
                status: status,
                arriveTime: arriveTime,
                sendTime: sendTime,
                recipient: recipient,
                phone: phone,
                address: address,
                rowIndex: rowIndex,
                columnIndex: columnIndexes.trackingNumber >= 0 ? columnIndexes.trackingNumber : 1,
                columnName: columnName,
                originalData: jsonData
              });

              keyCounter++;
            }
          }
        });
      });

      console.log('所有工作表处理后的数据:', allProcessedData);

      if (allProcessedData.length > 0) {
        // 使用缓存合并逻辑
        const mergedData = await mergeDataWithLocal(allProcessedData);
        setData(mergedData);
        setFilteredData(mergedData);
        
        const localCount = mergedData.filter(item => item.source === 'local').length;
        const excelCount = mergedData.filter(item => item.source === 'excel').length;
        
        message.success(
          `成功加载数据：Excel ${excelCount} 条，本地缓存 ${localCount} 条，共 ${mergedData.length} 条快递信息`
        );
      } else {
        // 如果Excel文件没有数据，尝试从本地缓存加载
        try {
          const localData = await dbRef.current.getAllData();
          if (localData.length > 0) {
            const dataWithKeys = localData.map((item, index) => ({
              ...item,
              key: index.toString()
            }));
            setData(dataWithKeys);
            setFilteredData(dataWithKeys);
            message.info(`Excel文件中未找到数据，已从本地缓存加载 ${localData.length} 条数据`);
          } else {
            // 如果本地也没有数据，使用硬编码的示例数据
            const fallbackData = createDefaultData();
            setData(fallbackData);
            setFilteredData(fallbackData);
            message.info('Excel文件和本地缓存均未找到数据，已加载示例数据');
          }
        } catch (error) {
          console.error('读取本地缓存失败:', error);
          const fallbackData = createDefaultData();
          setData(fallbackData);
          setFilteredData(fallbackData);
          message.info('Excel文件中未找到快递数据，已加载示例数据');
        }
      }

    } catch (error) {
      console.error('加载默认Excel文件失败:', error);
      
      // 如果加载失败，尝试从本地缓存获取数据
      try {
        const localData = await dbRef.current.getAllData();
        if (localData.length > 0) {
          const dataWithKeys = localData.map((item, index) => ({
            ...item,
            key: index.toString()
          }));
          setData(dataWithKeys);
          setFilteredData(dataWithKeys);
          message.warning(`无法加载Excel文件，已从本地缓存加载 ${localData.length} 条数据`);
        } else {
          // 本地也没有数据，使用硬编码的示例数据作为备选
          const fallbackData = createDefaultData();
          setData(fallbackData);
          setFilteredData(fallbackData);
          message.warning('无法加载默认Excel文件，已加载示例数据');
        }
      } catch (cacheError) {
        console.error('读取本地缓存也失败:', cacheError);
        // 本地缓存也失败，使用硬编码的示例数据作为备选
        const fallbackData = createDefaultData();
        setData(fallbackData);
        setFilteredData(fallbackData);
        message.warning('无法加载默认Excel文件，已加载示例数据');
      }
    } finally {
      setLoading(false);
    }
  };

  // 页面加载时读取默认Excel文件
  React.useEffect(() => {
    // 确保页面滚动到顶部
    window.scrollTo({ top: 0, behavior: 'smooth' });
    
    // 检查URL参数是否包含author=xubo
    const urlParams = new URLSearchParams(window.location.search);
    const author = urlParams.get('author');
    setShowEditButton(author === 'xubo');
    
    // 初始化IndexedDB并加载默认数据
    const initializeApp = async () => {
      try {
        await dbRef.current.initDB();
        console.log('IndexedDB 初始化成功');
      } catch (error) {
        console.error('IndexedDB 初始化失败:', error);
        message.warning('本地缓存初始化失败，将使用内存模式');
      }
      
      // 加载默认数据
      loadDefaultExcelData();
    };
    
    initializeApp();
  }, []);

  // 快递公司识别函数 - 根据实际数据优化，无法识别时返回空字符串
  const detectExpressCompany = (trackingNumber: string): string => {
    if (!trackingNumber) return '';

    const cleanNumber = trackingNumber.toString().trim();

    const patterns = {
      '中通': /^(ZTO|6)\d{10,15}$|^7\d{11,15}$/,
      '圆通': /^(YT|D|1)\d{11,15}$|^7\d{11,15}$/,
      '申通': /^(STO|268)\d{10,15}$|^7\d{11,15}$/,
      '韵达': /^(YD|19|1)\d{11,15}$|^7\d{11,15}$/,
      '顺丰': /^(SF)\d{10,15}$|^[89]\d{11,15}$/,
      '德邦': /^(DP|3)\d{11,15}$/,
      '邮政EMS': /^(E[A-Z])\d{9}[A-Z]{2}$|^(JD|JT)\d{11,15}$/,
      '京东': /^(JD|VA|JT)\d{11,15}$/,
      '天天': /^(TT|88)\d{11,15}$/,
      '百世': /^(HT|A)\d{11,15}$/,
    };

    for (const [company, pattern] of Object.entries(patterns)) {
      if (pattern.test(cleanNumber.toUpperCase())) {
        return company;
      }
    }
    return ''; // 无法识别时返回空字符串
  };

  // 处理Excel文件上传
  const handleFileUpload = (file: File) => {
    setLoading(true);

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });

        console.log('上传文件工作表列表:', workbook.SheetNames);

        const allProcessedData: ExpressData[] = [];
        let keyCounter = 0;

        // 遍历所有工作表
        workbook.SheetNames.forEach((sheetName) => {
          const worksheet = workbook.Sheets[sheetName];
          console.log(`处理上传文件工作表: ${sheetName}`, worksheet);

          // 将工作表转换为二维数组
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
          console.log(`上传文件工作表 ${sheetName} 数据:`, jsonData);

          if (jsonData.length <= 1) {
            console.log(`工作表 ${sheetName} 没有数据或只有表头`);
            return;
          }

          // 获取表头行并找到各列的索引
          const headerRow = jsonData[0] as any[];
          const getColumnIndex = (keywords: string[]) => {
            return headerRow.findIndex((header: any) => {
              if (!header) return false;
              const headerStr = header.toString();
              return keywords.some(keyword => headerStr.includes(keyword));
            });
          };

          const columnIndexes = {
            company: getColumnIndex(['来源公司', '公司']),
            trackingNumber: getColumnIndex(['快递单号', '单号']),
            type: getColumnIndex(['类型']),
            status: getColumnIndex(['状态']),
            arriveTime: getColumnIndex(['到仓时间', '到仓']),
            sendTime: getColumnIndex(['发出时间', '发出']),
            recipient: getColumnIndex(['收件人', '姓名']),
            phone: getColumnIndex(['电话号码', '手机号', '联系电话', '电话']),
            address: getColumnIndex(['家庭住址', '地址', '收货地址'])
          };

          // 遍历所有行和列
          jsonData.forEach((row: any[], rowIndex) => {
            if (Array.isArray(row) && rowIndex > 0) { // 跳过标题行
              // 首先尝试从指定列获取快递单号
              let trackingNumber = '';
              if (columnIndexes.trackingNumber >= 0 && row[columnIndexes.trackingNumber]) {
                trackingNumber = row[columnIndexes.trackingNumber].toString().trim();
              } else {
                // 如果没有找到快递单号列，则遍历所有列寻找快递单号
                row.forEach((cell: any, columnIndex) => {
                  if (!trackingNumber) {
                    const cellValue = cell ? cell.toString().trim() : '';
                    if (cellValue &&
                      cellValue.length > 5 &&
                      /^[A-Za-z0-9]+$/.test(cellValue)) {
                      trackingNumber = cellValue;
                    }
                  }
                });
              }

              if (trackingNumber) {
                // 获取其他字段的值
                const company = columnIndexes.company >= 0 && row[columnIndexes.company] 
                  ? row[columnIndexes.company].toString().trim() 
                  : detectExpressCompany(trackingNumber);

                const type = columnIndexes.type >= 0 && row[columnIndexes.type] 
                  ? row[columnIndexes.type].toString().trim() 
                  : '';

                const status = columnIndexes.status >= 0 && row[columnIndexes.status] 
                  ? row[columnIndexes.status].toString().trim() 
                  : '';

                const arriveTime = columnIndexes.arriveTime >= 0 && row[columnIndexes.arriveTime] 
                  ? row[columnIndexes.arriveTime].toString().trim() 
                  : '';

                const sendTime = columnIndexes.sendTime >= 0 && row[columnIndexes.sendTime] 
                  ? row[columnIndexes.sendTime].toString().trim() 
                  : '';

                const recipient = columnIndexes.recipient >= 0 && row[columnIndexes.recipient] 
                  ? row[columnIndexes.recipient].toString().trim() 
                  : '';

                const phone = columnIndexes.phone >= 0 && row[columnIndexes.phone] 
                  ? row[columnIndexes.phone].toString().trim() 
                  : '';

                const address = columnIndexes.address >= 0 && row[columnIndexes.address] 
                  ? row[columnIndexes.address].toString().trim() 
                  : '';

                // 获取列名（从第一行）
                const columnName = headerRow && headerRow[columnIndexes.trackingNumber >= 0 ? columnIndexes.trackingNumber : 1]
                  ? headerRow[columnIndexes.trackingNumber >= 0 ? columnIndexes.trackingNumber : 1].toString()
                  : `列${columnIndexes.trackingNumber >= 0 ? columnIndexes.trackingNumber + 1 : 2}`;

                allProcessedData.push({
                  key: keyCounter.toString(),
                  trackingNumber: trackingNumber,
                  company: company,
                  batchNumber: sheetName, // 使用sheetName作为批次号
                  type: type,
                  status: status,
                  arriveTime: arriveTime,
                  sendTime: sendTime,
                  recipient: recipient,
                  phone: phone,
                  address: address,
                  rowIndex: rowIndex,
                  columnIndex: columnIndexes.trackingNumber >= 0 ? columnIndexes.trackingNumber : 1,
                  columnName: columnName,
                  originalData: jsonData
                });

                keyCounter++;
              }
            }
          });
        });

        console.log('上传文件所有工作表处理后数据:', allProcessedData);
        
        // 使用缓存合并逻辑
        const mergedData = await mergeDataWithLocal(allProcessedData);
        setData(mergedData);
        setFilteredData(mergedData);
        setSearchValue('');
        
        const localCount = mergedData.filter(item => item.source === 'local').length;
        const excelCount = mergedData.filter(item => item.source === 'excel').length;
        
        message.success(
          `成功读取文件：Excel ${excelCount} 条，本地缓存 ${localCount} 条，共 ${mergedData.length} 条快递信息`
        );
      } catch (error) {
        console.error('文件解析失败:', error);
        message.error('文件解析失败，请确保文件格式正确');
      } finally {
        setLoading(false);
      }
    };

    reader.readAsArrayBuffer(file);
    return false; // 阻止自动上传
  };

  // Upload组件配置
  const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: '.xlsx,.xls',
    beforeUpload: (file: File) => {
      handleFileUpload(file);
      return false; // 阻止默认上传行为
    },
    onDrop(e: React.DragEvent) {
      console.log('Dropped files', e.dataTransfer.files);
    },
  };

  // 搜索功能
  const handleSearch = (value: string) => {
    setSearchValue(value);
    resetAllFilters(); // 搜索时重置所有筛选
    if (!value) {
      setFilteredData(data);
      return;
    }

    const filtered = data.filter(item =>
      item.trackingNumber.toLowerCase().includes(value.toLowerCase()) ||
      item.company.includes(value) ||
      (item.recipient && item.recipient.includes(value)) ||
      (item.phone && item.phone.includes(value)) ||
      (item.address && item.address.includes(value)) ||
      (item.type && item.type.includes(value)) ||
      (item.status && item.status.includes(value)) ||
      (item.batchNumber && item.batchNumber.includes(value))
    );
    setFilteredData(filtered);
  };

  // 按快递公司分类
  const handleCompanyFilter = (company: string) => {
    setSelectedCompany(company);
    applyFilters(selectedBatch, company, selectedType, selectedStatus);
  };

  // 按批次筛选
  const handleBatchFilter = (batchNumber: string) => {
    setSelectedBatch(batchNumber);
    applyFilters(batchNumber, selectedCompany, selectedType, selectedStatus);
  };

  // 按类型筛选
  const handleTypeFilter = (type: string) => {
    setSelectedType(type);
    applyFilters(selectedBatch, selectedCompany, type, selectedStatus);
  };

  // 按状态筛选
  const handleStatusFilter = (status: string) => {
    setSelectedStatus(status);
    applyFilters(selectedBatch, selectedCompany, selectedType, status);
  };

  // 应用所有筛选条件
  const applyFilters = (batch: string, company: string, type: string, status: string) => {
    let filtered = data;

    // 批次筛选
    if (batch !== '全部') {
      filtered = filtered.filter(item => item.batchNumber === batch);
    }

    // 公司筛选
    if (company !== '全部') {
      filtered = filtered.filter(item => item.company === company);
    }

    // 类型筛选
    if (type !== '全部') {
      filtered = filtered.filter(item => item.type === type);
    }

    // 状态筛选
    if (status !== '全部') {
      filtered = filtered.filter(item => item.status === status);
    }

    setFilteredData(filtered);
    
    // 更新搜索值显示
    const filters = [];
    if (batch !== '全部') filters.push(`批次: ${batch}`);
    if (company !== '全部') filters.push(`公司: ${company}`);
    if (type !== '全部') filters.push(`类型: ${type}`);
    if (status !== '全部') filters.push(`状态: ${status}`);
    
    setSearchValue(filters.length > 0 ? filters.join(' | ') : '');
  };

  // 重置所有筛选
  const resetAllFilters = () => {
    setSelectedBatch('全部');
    setSelectedCompany('全部');
    setSelectedType('全部');
    setSelectedStatus('全部');
    setFilteredData(data);
    setSearchValue('');
  };

  // 编辑记录
  const handleEdit = (record: ExpressData) => {
    setEditingRecord(record);
    form.setFieldsValue({
      recipient: record.recipient,
      phone: record.phone,
      address: record.address,
      status: record.status,
      type: record.type,
      arriveTime: record.arriveTime,
      sendTime: record.sendTime
    });
    setDrawerVisible(true);
  };

  // 保存编辑
  const handleSave = async () => {
    try {
      const values = await form.validateFields();

      if (editingRecord) {
        const updatedRecord: ExpressData = {
          ...editingRecord,
          ...values,
          lastUpdated: Date.now(),
          source: 'local'
        };

        const updatedData = data.map(item => {
          if (item.key === editingRecord.key) {
            return updatedRecord;
          }
          return item;
        });

        setData(updatedData);

        // 更新过滤后的数据
        const updatedFilteredData = filteredData.map(item => {
          if (item.key === editingRecord.key) {
            return updatedRecord;
          }
          return item;
        });
        setFilteredData(updatedFilteredData);

        // 保存到本地缓存
        try {
          await dbRef.current.saveData([updatedRecord]);
          console.log('数据已保存到本地缓存');
        } catch (cacheError) {
          console.error('保存到本地缓存失败:', cacheError);
          message.warning('数据已保存到内存，但本地缓存更新失败');
        }

        message.success('保存成功');
        setDrawerVisible(false);
        setEditingRecord(null);
        form.resetFields();
      }
    } catch (error) {
      console.error('Validation failed:', error);
    }
  };

  // 清除本地缓存
  const handleClearCache = async () => {
    Modal.confirm({
      title: '确认清除本地缓存',
      icon: <ExclamationCircleOutlined />,
      content: (
        <div>
          <p>您即将清除所有本地缓存数据，此操作不可撤销。</p>
          <p style={{ color: '#ff4d4f', fontWeight: 'bold' }}>
            ⚠️ 警告：所有本地编辑的快递信息将被永久删除！
          </p>
          <p>清除后系统将重新从默认Excel文件加载数据。</p>
        </div>
      ),
      okText: '确认清除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await dbRef.current.clearAllData();
          message.success('本地缓存已清除');
          console.log('本地缓存已清除');
          
          // 重新加载数据（只从Excel获取）
          loadDefaultExcelData();
        } catch (error) {
          console.error('清除缓存失败:', error);
          message.error('清除缓存失败');
        }
      },
      onCancel: () => {
        message.info('已取消清除缓存操作');
      }
    });
  };

  // 导出数据到Excel
  const handleExportData = () => {
    try {
      // 按批次分组数据
      const batchGroups: { [key: string]: ExpressData[] } = {};
      filteredData.forEach(item => {
        const batch = item.batchNumber || '未分组';
        if (!batchGroups[batch]) {
          batchGroups[batch] = [];
        }
        batchGroups[batch].push(item);
      });

      // 创建工作簿
      const workbook = XLSX.utils.book_new();
      
      // 设置列宽
      const colWidths = [
        { wch: 8 },   // 序号
        { wch: 15 },  // 快递批次
        { wch: 20 },  // 快递单号
        { wch: 12 },  // 快递公司
        { wch: 10 },  // 类型
        { wch: 12 },  // 状态
        { wch: 15 },  // 到仓时间
        { wch: 15 },  // 发出时间
        { wch: 12 },  // 收件人
        { wch: 15 },  // 电话号码
        { wch: 30 }   // 家庭住址
      ];

      let totalRecords = 0;
      const batchNames: string[] = [];

      // 为每个批次创建工作表
      Object.entries(batchGroups).forEach(([batchName, batchData]) => {
        // 准备该批次的导出数据
        const exportData = batchData.map((item, index) => ({
          '序号': index + 1,
          '快递批次': item.batchNumber || '',
          '快递单号': item.trackingNumber || '',
          '快递公司': item.company || '',
          '类型': item.type || '',
          '状态': item.status || '',
          '到仓时间': item.arriveTime || '',
          '发出时间': item.sendTime || '',
          '收件人': item.recipient || '',
          '电话号码': item.phone || '',
          '家庭住址': item.address || ''
        }));

        // 创建工作表
        const worksheet = XLSX.utils.json_to_sheet(exportData);
        worksheet['!cols'] = colWidths;

        // 限制工作表名称长度，避免Excel限制
        const sheetName = batchName.length > 31 ? batchName.substring(0, 31) : batchName;
        
        // 添加工作表到工作簿
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
        
        totalRecords += batchData.length;
        batchNames.push(`${sheetName}(${batchData.length}条)`);
      });

      // 生成文件名（包含当前时间）
      const now = new Date();
      const timestamp = now.toISOString().slice(0, 19).replace(/[:-]/g, '').replace('T', '_');
      const filename = `快递数据_按批次分表_${timestamp}.xlsx`;

      // 导出文件
      XLSX.writeFile(workbook, filename);
      
      message.success(`成功导出 ${Object.keys(batchGroups).length} 个工作表，共 ${totalRecords} 条数据到 ${filename}。工作表: ${batchNames.join(', ')}`);
    } catch (error) {
      console.error('导出失败:', error);
      message.error('导出失败，请重试');
    }
  };

  // 获取快递公司统计
  const getCompanyStats = () => {
    const stats: { [key: string]: number } = {};
    data.forEach(item => {
      stats[item.company] = (stats[item.company] || 0) + 1;
    });
    return stats;
  };

  // 获取批次统计
  const getBatchStats = () => {
    const stats: { [key: string]: number } = {};
    data.forEach(item => {
      stats[item.batchNumber] = (stats[item.batchNumber] || 0) + 1;
    });
    return stats;
  };

  // 获取类型统计
  const getTypeStats = () => {
    const stats: { [key: string]: number } = {};
    data.forEach(item => {
      if (item.type) {
        stats[item.type] = (stats[item.type] || 0) + 1;
      }
    });
    return stats;
  };

  // 获取状态统计
  const getStatusStats = () => {
    const stats: { [key: string]: number } = {};
    data.forEach(item => {
      if (item.status) {
        stats[item.status] = (stats[item.status] || 0) + 1;
      }
    });
    return stats;
  };

  // 表格列配置
  const columns = [
    {
      title: '序号',
      dataIndex: 'rowIndex',
      key: 'rowIndex',
      width: 80,
      render: (_: any, __: any, index: number) => (
        <div style={{
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          color: 'white',
          padding: '4px 8px',
          borderRadius: '12px',
          textAlign: 'center',
          fontSize: '12px',
          fontWeight: 'bold',
          display: 'inline-block',
          minWidth: '24px'
        }}>
          {index + 1}
        </div>
      ),
    },
    {
      title: '快递批次',
      dataIndex: 'batchNumber',
      key: 'batchNumber',
      width: 140,
      render: (text: string, record: ExpressData) => (
        <Space direction="vertical" size={2}>
          <Tag 
            color="purple" 
            style={{ 
              borderRadius: '12px',
              padding: '2px 8px',
              fontSize: '12px',
              fontWeight: 'bold'
            }}
          >
            {text || '-'}
          </Tag>
          {record.source && showEditButton && (
            <Tag 
              color={record.source === 'local' ? 'green' : 'blue'}
              style={{ 
                fontSize: '10px', 
                padding: '1px 6px',
                borderRadius: '8px',
                fontWeight: 'bold'
              }}
            >
              {record.source === 'local' ? '本地' : 'Excel'}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '快递单号',
      dataIndex: 'trackingNumber',
      key: 'trackingNumber',
      width: 180,
      render: (text: string) => (
        <Text 
          style={{ 
            background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
            color: 'white',
            padding: '4px 8px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 'bold'
          }}
        >
          {text}
        </Text>
      )
    },
    {
      title: '快递公司',
      dataIndex: 'company',
      key: 'company',
      width: 120,
      render: (company: string) => {
        if (!company) {
          return <Text type="secondary">-</Text>;
        }
        const colors: { [key: string]: string } = {
          '顺丰': '#faad14',
          '申通': '#a0d911',
          '圆通': '#52c41a',
          '中通': '#13c2c2',
          '韵达': '#1890ff',
          '德邦': '#2f54eb',
          '邮政EMS': '#722ed1',
          '京东': '#eb2f96',
          '天天': '#f5222d',
          '百世': '#fa541c',
        };
        return (
          <Tag 
            color={colors[company] || 'default'} 
            style={{ 
              borderRadius: '12px',
              padding: '4px 8px',
              fontSize: '12px',
              fontWeight: 'bold'
            }}
          >
            {company}
          </Tag>
        );
      },
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 100,
      render: (type: string) => {
        if (!type) return <Text type="secondary">-</Text>;
        const isCorrect = type.includes('正常');
        return (
          <Tag 
            color={isCorrect ? '#52c41a': '#f5222d'} 
            style={{ 
              borderRadius: '12px',
              padding: '4px 8px',
              fontSize: '12px',
              fontWeight: 'bold'
            }}
          >
            {type}
          </Tag>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: string) => {
        if (!status) return <Text type="secondary">-</Text>;
        
        let color = '#1890ff';
        if (status.includes('滞留') || status.includes('仓库')) {
          color = '#faad14';
        } else if (status.includes('发出') || status.includes('送达') || status.includes('完成')) {
          color = '#52c41a';
        }
        
        return (
          <Tag 
            color={color} 
            style={{ 
              borderRadius: '12px',
              padding: '4px 8px',
              fontSize: '12px',
              fontWeight: 'bold'
            }}
          >
            {status}
          </Tag>
        );
      },
    },
    {
      title: '到仓时间',
      dataIndex: 'arriveTime',
      key: 'arriveTime',
      width: 120,
      render: (time: string) => time ? (
        <Text style={{ fontSize: '12px', color: '#666' }}>{time}</Text>
      ) : (
        <Text type="secondary">-</Text>
      ),
    },
    {
      title: '发出时间',
      dataIndex: 'sendTime',
      key: 'sendTime',
      width: 120,
      render: (time: string) => time ? (
        <Text style={{ fontSize: '12px', color: '#666' }}>{time}</Text>
      ) : (
        <Text type="secondary">-</Text>
      ),
    },
    // 根据URL参数动态显示收件人、电话号码和家庭住址列
    ...(showEditButton ? [
      {
        title: '收件人',
        dataIndex: 'recipient',
        key: 'recipient',
        width: 100,
        render: (text: string) => text ? (
          <Text style={{ 
            color: '#1890ff', 
            fontWeight: 'bold',
            background: 'rgba(24, 144, 255, 0.1)',
            padding: '2px 6px',
            borderRadius: '4px',
            fontSize: '12px'
          }}>
            {text}
          </Text>
        ) : (
          <Text type="secondary" style={{ fontSize: '12px' }}>未填写</Text>
        ),
      },
      {
        title: '电话号码',
        dataIndex: 'phone',
        key: 'phone',
        width: 120,
        render: (text: string) => text ? (
          <Text style={{ 
            color: '#52c41a', 
            fontWeight: 'bold',
            background: 'rgba(82, 196, 26, 0.1)',
            padding: '2px 6px',
            borderRadius: '4px',
            fontSize: '12px'
          }}>
            {text}
          </Text>
        ) : (
          <Text type="secondary" style={{ fontSize: '12px' }}>未填写</Text>
        ),
      },
      {
        title: '家庭住址',
        dataIndex: 'address',
        key: 'address',
        ellipsis: true,
        render: (text: string) => text ? (
          <Text style={{ 
            color: '#722ed1', 
            fontWeight: 'bold',
            background: 'rgba(114, 46, 209, 0.1)',
            padding: '2px 6px',
            borderRadius: '4px',
            fontSize: '12px'
          }}>
            {text}
          </Text>
        ) : (
          <Text type="secondary" style={{ fontSize: '12px' }}>未填写</Text>
        ),
      },
    ] : []),
    // 根据URL参数动态显示操作列
    ...(showEditButton ? [{
      title: '操作',
      key: 'action',
      fixed: 'right' as const,
      width: 100,
      render: (_: any, record: ExpressData) => (
        <Button
          type="primary"
          size="small"
          icon={<EditOutlined />}
          onClick={() => handleEdit(record)}
          style={{
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            border: 'none',
            borderRadius: '6px',
            fontWeight: 'bold'
          }}
        >
          编辑
        </Button>
      ),
    }] : []),
  ];

  const companyStats = getCompanyStats();
  const batchStats = getBatchStats();
  const typeStats = getTypeStats();
  const statusStats = getStatusStats();

  return (
    <div
      id="page-container"
      style={{
        padding: '16px',
        minHeight: '100vh',
        width: '100%'
      }}
    >
      {/* 主标题区域 */}
      <div style={{
        textAlign: 'center',
        marginBottom: '32px',
        padding: '24px',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        borderRadius: '16px',
        boxShadow: '0 8px 32px rgba(102, 126, 234, 0.3)',
        color: 'white',
        maxWidth: '1600px',
        margin: '0 auto 32px auto'
      }}>
        <Title 
          level={1} 
          style={{ 
            color: 'white', 
            marginBottom: '8px',
            fontSize: '2.5rem',
            fontWeight: 'bold'
          }} 
          id="page-top"
        >
          <FileExcelOutlined style={{ marginRight: '12px' }} />
          快递问题件管理系统
        </Title>
        <Text style={{ 
          color: 'rgba(255, 255, 255, 0.9)', 
          fontSize: '16px',
          display: 'block'
        }}>
          智能快递数据管理
        </Text>
      </div>

      <div style={{ maxWidth: '1600px', margin: '0 auto' }}>

        {/* 统计卡片区域 */}
        {data.length > 0 && (
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', 
            gap: '16px', 
            marginBottom: '24px' 
          }}>
            <Card
              style={{
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                border: 'none',
                borderRadius: '12px',
                boxShadow: '0 4px 20px rgba(102, 126, 234, 0.3)',
                padding: '20px'
              }}
            >
              <div style={{ textAlign: 'center', color: 'white' }}>
                <div style={{ fontSize: '28px', fontWeight: 'bold', marginBottom: '4px' }}>
                  {data.length}
                </div>
                <div style={{ opacity: 0.9 }}>总快递数量</div>
              </div>
            </Card>

            <Card
              style={{
                background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
                border: 'none',
                borderRadius: '12px',
                boxShadow: '0 4px 20px rgba(240, 147, 251, 0.3)',
                padding: '20px'
              }}
            >
              <div style={{ textAlign: 'center', color: 'white' }}>
                <div style={{ fontSize: '28px', fontWeight: 'bold', marginBottom: '4px' }}>
                  {Object.keys(companyStats).length}
                </div>
                <div style={{ opacity: 0.9 }}>快递公司</div>
              </div>
            </Card>

            <Card
              style={{
                background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
                border: 'none',
                borderRadius: '12px',
                boxShadow: '0 4px 20px rgba(79, 172, 254, 0.3)',
                padding: '20px'
              }}
            >
              <div style={{ textAlign: 'center', color: 'white' }}>
                <div style={{ fontSize: '28px', fontWeight: 'bold', marginBottom: '4px' }}>
                  {Object.keys(batchStats).length}
                </div>
                <div style={{ opacity: 0.9 }}>快递批次</div>
              </div>
            </Card>

            <Card
              style={{
                background: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
                border: 'none',
                borderRadius: '12px',
                padding: '20px',
                boxShadow: '0 4px 20px rgba(250, 112, 154, 0.3)'
              }}
            >
              <div style={{ textAlign: 'center', color: 'white' }}>
                <div style={{ fontSize: '28px', fontWeight: 'bold', marginBottom: '4px' }}>
                  {filteredData.length}
                </div>
                <div style={{ opacity: 0.9 }}>当前显示</div>
              </div>
            </Card>
          </div>
        )}

        {/* 文件上传区域 - 仅限author=xubo */}
        {showEditButton && (
          <Card 
            style={{ 
              marginBottom: '24px',
              borderRadius: '12px',
              boxShadow: '0 4px 20px rgba(0, 0, 0, 0.1)',
              border: 'none'
            }} 
            title={
              <div style={{ display: 'flex', alignItems: 'center', color: '#52c41a' }}>
                <InboxOutlined style={{ marginRight: '8px', fontSize: '18px' }} />
                <span style={{ fontSize: '16px', fontWeight: 'bold' }}>数据导入</span>
              </div>
            }
            extra={
              <Space>
                <Button
                  type="default"
                  onClick={loadDefaultExcelData}
                  loading={loading}
                  icon={<FileExcelOutlined />}
                  style={{ borderRadius: '6px' }}
                >
                  重新加载默认数据
                </Button>
                <CreateSampleData />
              </Space>
            }
          >
            <div style={{
              background: 'linear-gradient(135deg, #52c41a 0%, #73d13d 100%)',
              borderRadius: '8px',
              padding: '16px',
              marginBottom: '16px'
            }}>
              <Dragger 
                {...uploadProps} 
                style={{ 
                  background: 'rgba(255, 255, 255, 0.9)',
                  border: '2px dashed rgba(255, 255, 255, 0.8)',
                  borderRadius: '8px',
                  padding: '20px'
                }}
              >
                <p className="ant-upload-drag-icon" style={{ color: '#52c41a' }}>
                  <InboxOutlined style={{ fontSize: '48px' }} />
                </p>
                <p className="ant-upload-text" style={{ color: '#333', fontSize: '16px', fontWeight: 'bold' }}>
                  点击或拖拽Excel文件到此区域上传
                </p>
                <p className="ant-upload-hint" style={{ color: '#666' }}>
                  支持 .xlsx 和 .xls 格式文件。系统会自动识别快递单号并合并到本地缓存中。
                </p>
              </Dragger>
            </div>
            
            <div style={{
              background: 'rgba(82, 196, 26, 0.1)',
              borderRadius: '6px',
              padding: '12px',
              border: '1px solid rgba(82, 196, 26, 0.2)'
            }}>
              <Text style={{ color: '#52c41a', fontWeight: 'bold' }}>
                <FileExcelOutlined style={{ marginRight: '6px' }} />
                导入说明：
              </Text>
              <div style={{ marginTop: '8px', color: '#666' }}>
                <div>• 支持标准Excel格式（.xlsx/.xls）</div>
                <div>• 自动识别列：快递单号、快递公司、类型、状态、到仓时间、发出时间、收件人、电话号码、家庭住址</div>
                <div>• 新数据会自动添加到本地缓存，已存在的数据会保留本地修改</div>
                <div>• 每个工作表作为一个快递批次处理</div>
              </div>
            </div>
          </Card>
        )}

        {/* 快递公司分布图表 */}
        {/* {data.length > 0 && (
          <Card style={{ marginBottom: '24px' }} title="快递公司分布">
            <Space wrap>
              <Button
                onClick={() => handleCompanyFilter('全部')}
                type={selectedCompany === '全部' ? 'primary' : 'default'}
              >
                全部 ({data.length})
              </Button>
              {Object.entries(companyStats).map(([company, count]) => (
                <Button
                  key={company}
                  onClick={() => handleCompanyFilter(company)}
                  type={selectedCompany === company ? 'primary' : 'default'}
                >
                  {company} ({count})
                </Button>
              ))}
            </Space>
          </Card>
        )} */}

        {/* 搜索区域 */}
        {data.length > 0 && (
          <Card 
            style={{ 
              marginBottom: '24px',
              borderRadius: '12px',
              boxShadow: '0 4px 20px rgba(0, 0, 0, 0.1)',
              border: 'none'
            }} 
            title={
              <div style={{ display: 'flex', alignItems: 'center', color: '#1890ff' }}>
                <SearchOutlined style={{ marginRight: '8px', fontSize: '18px' }} />
                <span style={{ fontSize: '16px', fontWeight: 'bold' }}>智能搜索</span>
              </div>
            }
          >
            <div style={{
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              borderRadius: '8px',
              padding: '16px',
              marginBottom: '16px'
            }}>
              <Search
                placeholder="输入快递单号进行精准搜索..."
                allowClear
                enterButton={
                  <Button 
                    type="primary" 
                    style={{ 
                      background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
                      border: 'none',
                      borderRadius: '6px'
                    }}
                  >
                    <SearchOutlined />
                  </Button>
                }
                size="large"
                onSearch={handleSearch}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  if (!e.target.value) {
                    handleSearch('');
                  }
                }}
                style={{ 
                  borderRadius: '8px',
                  overflow: 'hidden'
                }}
              />
            </div>
            {searchValue && (
              <div style={{
                background: 'rgba(24, 144, 255, 0.1)',
                borderRadius: '6px',
                padding: '8px 12px',
                display: 'inline-block'
              }}>
                <Text type="secondary">
                  <SearchOutlined style={{ marginRight: '6px' }} />
                  搜索条件: {searchValue} | 找到 <Text strong style={{ color: '#1890ff' }}>{filteredData.length}</Text> 条结果
                </Text>
              </div>
            )}
          </Card>
        )}

        {/* 筛选区域 */}
        {data.length > 0 && (
          <Card 
            style={{ 
              marginBottom: '24px',
              borderRadius: '12px',
              boxShadow: '0 4px 20px rgba(0, 0, 0, 0.1)',
              border: 'none'
            }} 
            title={
              <div style={{ display: 'flex', alignItems: 'center', color: '#722ed1' }}>
                <FilterOutlined style={{ marginRight: '8px', fontSize: '18px' }} />
                <span style={{ fontSize: '16px', fontWeight: 'bold' }}>数据筛选</span>
              </div>
            }
            extra={
              <Button 
                onClick={resetAllFilters} 
                size="small" 
                type="text"
                style={{ 
                  fontSize: '12px',
                  color: '#1890ff',
                  fontWeight: 'bold'
                }}
              >
                重置筛选
              </Button>
            }
          >
            <div style={{
              background: 'linear-gradient(135deg, #722ed1 0%, #eb2f96 100%)',
              borderRadius: '8px',
              padding: '16px'
            }}>
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', 
                gap: '16px',
                alignItems: 'center'
              }}>
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '8px',
                  background: 'rgba(255, 255, 255, 0.9)',
                  padding: '8px 12px',
                  borderRadius: '8px'
                }}>
                  <Text strong style={{ fontSize: '14px', color: '#333', minWidth: '50px' }}>批次:</Text>
                  <Select
                    value={selectedBatch}
                    onChange={handleBatchFilter}
                    style={{ flex: 1, minWidth: '120px' }}
                    size="middle"
                  >
                    <Select.Option value="全部">全部</Select.Option>
                    {Object.entries(batchStats).map(([batchNumber, count]) => (
                      <Select.Option key={batchNumber} value={batchNumber}>
                        {batchNumber} ({count})
                      </Select.Option>
                    ))}
                  </Select>
                </div>
                
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '8px',
                  background: 'rgba(255, 255, 255, 0.9)',
                  padding: '8px 12px',
                  borderRadius: '8px'
                }}>
                  <Text strong style={{ fontSize: '14px', color: '#333', minWidth: '50px' }}>公司:</Text>
                  <Select
                    value={selectedCompany}
                    onChange={handleCompanyFilter}
                    style={{ flex: 1, minWidth: '120px' }}
                    size="middle"
                  >
                    <Select.Option value="全部">全部</Select.Option>
                    {Object.entries(companyStats).map(([company, count]) => (
                      <Select.Option key={company} value={company}>
                        {company} ({count})
                      </Select.Option>
                    ))}
                  </Select>
                </div>

                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '8px',
                  background: 'rgba(255, 255, 255, 0.9)',
                  padding: '8px 12px',
                  borderRadius: '8px'
                }}>
                  <Text strong style={{ fontSize: '14px', color: '#333', minWidth: '50px' }}>类型:</Text>
                  <Select
                    value={selectedType}
                    onChange={handleTypeFilter}
                    style={{ flex: 1, minWidth: '120px' }}
                    size="middle"
                  >
                    <Select.Option value="全部">全部</Select.Option>
                    {Object.entries(typeStats).map(([type, count]) => (
                      <Select.Option key={type} value={type}>
                        {type} ({count})
                      </Select.Option>
                    ))}
                  </Select>
                </div>

                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '8px',
                  background: 'rgba(255, 255, 255, 0.9)',
                  padding: '8px 12px',
                  borderRadius: '8px'
                }}>
                  <Text strong style={{ fontSize: '14px', color: '#333', minWidth: '50px' }}>状态:</Text>
                  <Select
                    value={selectedStatus}
                    onChange={handleStatusFilter}
                    style={{ flex: 1, minWidth: '120px' }}
                    size="middle"
                  >
                    <Select.Option value="全部">全部</Select.Option>
                    {Object.entries(statusStats).map(([status, count]) => (
                      <Select.Option key={status} value={status}>
                        {status} ({count})
                      </Select.Option>
                    ))}
                  </Select>
                </div>
              </div>
            </div>
            
            {/* 筛选结果提示 */}
            {(selectedBatch !== '全部' || selectedCompany !== '全部' || selectedType !== '全部' || selectedStatus !== '全部') && (
              <div style={{
                background: 'rgba(114, 46, 209, 0.1)',
                borderRadius: '6px',
                padding: '12px',
                marginTop: '16px',
                border: '1px solid rgba(114, 46, 209, 0.2)'
              }}>
                <Text style={{ color: '#722ed1', fontWeight: 'bold' }}>
                  <FilterOutlined style={{ marginRight: '6px' }} />
                  当前筛选条件：
                </Text>
                <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {selectedBatch !== '全部' && (
                    <Tag color="purple" style={{ borderRadius: '12px' }}>
                      批次: {selectedBatch}
                    </Tag>
                  )}
                  {selectedCompany !== '全部' && (
                    <Tag color="blue" style={{ borderRadius: '12px' }}>
                      公司: {selectedCompany}
                    </Tag>
                  )}
                  {selectedType !== '全部' && (
                    <Tag color="green" style={{ borderRadius: '12px' }}>
                      类型: {selectedType}
                    </Tag>
                  )}
                  {selectedStatus !== '全部' && (
                    <Tag color="orange" style={{ borderRadius: '12px' }}>
                      状态: {selectedStatus}
                    </Tag>
                  )}
                  <Text style={{ color: '#722ed1', fontWeight: 'bold' }}>
                    | 找到 <Text strong style={{ color: '#722ed1' }}>{filteredData.length}</Text> 条结果
                  </Text>
                </div>
              </div>
            )}
          </Card>
        )}

        {/* 数据表格 */}
        {data.length > 0 && (
          <Card 
            style={{
              borderRadius: '12px',
              boxShadow: '0 4px 20px rgba(0, 0, 0, 0.1)',
              border: 'none',
              overflow: 'hidden'
            }}
            title={
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  color: 'white',
                  padding: '8px 16px',
                  borderRadius: '20px',
                  marginRight: '12px',
                  fontSize: '14px',
                  fontWeight: 'bold'
                }}>
                  {filteredData.length}/{data.length}
                </div>
                <span style={{ fontSize: '16px', fontWeight: 'bold', color: '#1890ff' }}>
                  快递信息列表
                </span>
              </div>
            }
            extra={
              <Space wrap size="small">
                {showEditButton && (
                  <Button
                    type="primary"
                    icon={<DownloadOutlined />}
                    onClick={handleExportData}
                    size="middle"
                    style={{ 
                      background: 'linear-gradient(135deg, #52c41a 0%, #73d13d 100%)',
                      border: 'none',
                      borderRadius: '6px',
                      fontWeight: 'bold'
                    }}
                  >
                    导出数据
                  </Button>
                )}
                
                {showEditButton && (
                  <Button
                    type="default"
                    onClick={handleClearCache}
                    size="middle"
                    danger
                    style={{ borderRadius: '6px' }}
                  >
                    清除缓存
                  </Button>
                )}
              </Space>
            }
          >
            <Table
              columns={columns}
              dataSource={filteredData}
              loading={loading}
              pagination={{
                total: filteredData.length,
                showSizeChanger: true,
                showQuickJumper: true,
                showTotal: (total: number, range: [number, number]) =>
                  `第 ${range[0]}-${range[1]} 条/共 ${total} 条`,
                style: { marginTop: '16px' }
              }}
              scroll={{ x: showEditButton ? 1600 : 1000 }}
              size="middle"
              style={{
                background: 'white',
                borderRadius: '8px'
              }}
            />
          </Card>
        )}
      </div>

      {/* 编辑抽屉 */}
      <Drawer
        title={
          <div style={{ 
            color: '#1890ff', 
            fontSize: '18px', 
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center'
          }}>
            <EditOutlined style={{ marginRight: '8px' }} />
            编辑快递信息
          </div>
        }
        placement="right"
        onClose={() => {
          setDrawerVisible(false);
          setEditingRecord(null);
          form.resetFields();
        }}
        open={drawerVisible}
        width={420}
        extra={
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSave}
            style={{
              background: 'linear-gradient(135deg, #52c41a 0%, #73d13d 100%)',
              border: 'none',
              borderRadius: '6px',
              fontWeight: 'bold'
            }}
          >
            保存
          </Button>
        }
        styles={{
          header: {
            borderBottom: '2px solid #f0f0f0',
            paddingBottom: '16px'
          },
          body: {
            background: '#fafafa'
          }
        }}
      >
        {editingRecord && (
          <div style={{ padding: '16px' }}>
            <Form
              form={form}
              layout="vertical"
            >
              <div style={{ 
                marginBottom: '20px',
                padding: '16px',
                background: 'white',
                borderRadius: '8px',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)'
              }}>
                <div style={{ marginBottom: '12px' }}>
                  <Text strong style={{ color: '#1890ff' }}>快递单号：</Text>
                  <div style={{ marginTop: '4px' }}>
                    <Text 
                      code 
                      style={{ 
                        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                        color: 'white',
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontSize: '14px'
                      }}
                    >
                      {editingRecord.trackingNumber}
                    </Text>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                  <div>
                    <Text strong style={{ color: '#1890ff' }}>快递批次：</Text>
                    <div style={{ marginTop: '4px' }}>
                      <Tag color="purple" style={{ borderRadius: '12px' }}>
                        {editingRecord.batchNumber}
                      </Tag>
                    </div>
                  </div>

                  <div>
                    <Text strong style={{ color: '#1890ff' }}>快递公司：</Text>
                    <div style={{ marginTop: '4px' }}>
                      {editingRecord.company ? (
                        <Tag color="green" style={{ borderRadius: '12px' }}>
                          {editingRecord.company}
                        </Tag>
                      ) : (
                        <Text type="secondary">未识别</Text>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 1fr', 
                gap: '16px',
                marginBottom: '16px'
              }}>
                <Form.Item
                  name="type"
                  label={<Text strong style={{ color: '#1890ff' }}>类型</Text>}
                >
                  <Input
                    style={{ width: '100%' }}
                    placeholder="请输入类型"
                    allowClear
                  />
                </Form.Item>

                <Form.Item
                  name="status"
                  label={<Text strong style={{ color: '#1890ff' }}>状态</Text>}
                >
                  <Select
                    style={{ width: '100%' }}
                    placeholder="请选择状态"
                    allowClear
                  >
                    <Select.Option value="滞留仓库">滞留仓库</Select.Option>
                    <Select.Option value="已发出">已发出</Select.Option>
                    <Select.Option value="已送达">已送达</Select.Option>
                    <Select.Option value="待处理">待处理</Select.Option>
                    <Select.Option value="处理中">处理中</Select.Option>
                    <Select.Option value="已完成">已完成</Select.Option>
                  </Select>
                </Form.Item>
              </div>

              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 1fr', 
                gap: '16px',
                marginBottom: '16px'
              }}>
                <Form.Item
                  name="arriveTime"
                  label={<Text strong style={{ color: '#1890ff' }}>到仓时间</Text>}
                >
                  <Input placeholder="请输入到仓时间" />
                </Form.Item>

                <Form.Item
                  name="sendTime"
                  label={<Text strong style={{ color: '#1890ff' }}>发出时间</Text>}
                >
                  <Input placeholder="请输入发出时间" />
                </Form.Item>
              </div>

              <Form.Item
                name="recipient"
                label={<Text strong style={{ color: '#1890ff' }}>收件人</Text>}
              >
                <Input placeholder="请输入收件人姓名" />
              </Form.Item>

              <Form.Item
                name="phone"
                label={<Text strong style={{ color: '#1890ff' }}>电话号码</Text>}
                rules={[
                  { pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号码' }
                ]}
              >
                <Input placeholder="请输入手机号码" />
              </Form.Item>

              <Form.Item
                name="address"
                label={<Text strong style={{ color: '#1890ff' }}>家庭住址</Text>}
              >
                <Input.TextArea
                  rows={4}
                  placeholder="请输入详细的家庭住址"
                  style={{ borderRadius: '6px' }}
                />
              </Form.Item>
            </Form>
          </div>
        )}
      </Drawer>

      {/* 回到顶部按钮 */}
      <FloatButton.BackTop
        style={{ 
          right: 24, 
          bottom: 24,
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          borderRadius: '50%',
          boxShadow: '0 4px 20px rgba(102, 126, 234, 0.4)'
        }}
        icon={<UpOutlined style={{ color: 'white' }} />}
        tooltip="回到顶部"
        target={() => window}
        visibilityHeight={100}
      />
    </div>
  );
};

export default ExpressQuery;
