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
  /** 预期 SHA-256（下载后校验，防止下载源被篡改或文件损坏） */
  sha256: string
  /** 关键文件：缺失即视为模型未就绪 */
  required: boolean
}

export const CLIP_MODEL_FILES: ClipModelFileSpec[] = [
  {
    name: 'model_fp16.onnx',
    url: `${HF_BASE}/onnx/model_fp16.onnx`,
    expectedBytes: 377_377_730,
    sha256: '0fad978faa89b85fda53a83a4c202116a9eb87c8f9723fb4d85e4483efbce4b2',
    required: true
  },
  {
    name: 'vocab.txt',
    url: `${HF_BASE}/vocab.txt`,
    expectedBytes: 109_540,
    sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c',
    required: true
  },
  {
    name: 'tokenizer_config.json',
    url: `${HF_BASE}/tokenizer_config.json`,
    expectedBytes: 1_315,
    sha256: '38fbc894183595cc1168e36150251b2fb658197b3a49f6908cce88ae22acd52a',
    required: false
  },
  {
    name: 'preprocessor_config.json',
    url: `${HF_BASE}/preprocessor_config.json`,
    expectedBytes: 546,
    sha256: '61a78fdd2c7ac17b54b6190c0f4cb23423192c535003d52528d01e318a47608b',
    required: false
  },
  {
    name: 'config.json',
    url: `${HF_BASE}/config.json`,
    expectedBytes: 844,
    sha256: '19447ad8c20d274f0644a6663af56286be98bd2d0e5f9472fcb318e04fcd6961',
    required: false
  },
  {
    name: 'special_tokens_map.json',
    url: `${HF_BASE}/special_tokens_map.json`,
    expectedBytes: 125,
    sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
    required: false
  }
]

export const CLIP_MODEL_TOTAL_BYTES = CLIP_MODEL_FILES.reduce((s, f) => s + f.expectedBytes, 0)
