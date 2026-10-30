/** 来信图片：体积上限与按魔数判类型（不信任文件名）。 */

/** 一轮对话里最多看几张图。每次调用一张，这是上限——图片按体积算钱，也按体积算隐私。 */
export const MAX_IMAGES_PER_TURN = 2

/**
 * 来信图片的大小上限（D-128）。超了就明说"太大"，**不缩放**：入站文件是证据形态，
 * 缩了再给模型看，模型说的就不是那张图（导出路径缩放是因为那是给人看的页面）。
 */
export const MAX_INBOUND_IMAGE_BYTES = 4 * 1024 * 1024

/** 从文件头魔数判图片类型，不信任文件名——来信文件的名字来自服务端报文。 */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buf.length >= 12
    && buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }
  return null
}
