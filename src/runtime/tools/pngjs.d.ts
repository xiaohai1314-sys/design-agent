/** pngjs 无自带类型声明，这里只声明本项目用到的最小表面（PNG.sync.read 解码）。 */
declare module 'pngjs' {
  export class PNG {
    width: number
    height: number
    data: Buffer
    static sync: {
      read: (buf: Buffer | Uint8Array) => PNG
    }
  }
}
