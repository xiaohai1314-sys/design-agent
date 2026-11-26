/**
 * 本地向量模型（Chinese-CLIP ViT-B/16，Xenova ONNX 转换版）的共享常量。
 * 权重来源：HuggingFace Xenova/chinese-clip-vit-base-patch16（OFA-Sys 官方权重的标准转换，
 * 许可证 MIT）。应用不打包权重，首次使用时从该原始来源下载到用户数据目录，之后完全离线。
 */

export const CLIP_MODEL_ID = 'chinese-clip-vit-base-patch16'
export const CLIP_VECTOR_DIM = 512

const HF_BASE = 'https://huggingface.co/Xenova/chinese-clip-vit-base-patch16/resolve/main'

export interface ClipModelFileSpec {
  /** 落盘文件名（模型目录根下） */
  name: string
  url: string
  /** 预期字节数（状态校验/下载进度合计用；以模型仓库实际文件为准） */
  expectedBytes: number
  /** 关键文件：缺失即视为模型未就绪 */
  required: boolean
}

export const CLIP_MODEL_FILES: ClipModelFileSpec[] = [
  {
    name: 'model_fp16.onnx',
    url: `${HF_BASE}/onnx/model_fp16.onnx`,
    expectedBytes: 377_377_730,
    required: true
  },
  { name: 'vocab.txt', url: `${HF_BASE}/vocab.txt`, expectedBytes: 109_540, required: true },
  {
    name: 'tokenizer_config.json',
    url: `${HF_BASE}/tokenizer_config.json`,
    expectedBytes: 1_315,
    required: false
  },
  {
    name: 'preprocessor_config.json',
    url: `${HF_BASE}/preprocessor_config.json`,
    expectedBytes: 546,
    required: false
  },
  { name: 'config.json', url: `${HF_BASE}/config.json`, expectedBytes: 844, required: false },
  {
    name: 'special_tokens_map.json',
    url: `${HF_BASE}/special_tokens_map.json`,
    expectedBytes: 125,
    required: false
  }
]

export const CLIP_MODEL_TOTAL_BYTES = CLIP_MODEL_FILES.reduce((s, f) => s + f.expectedBytes, 0)
