/**
 * Static GrokBot appearance data — 10 colors / 8 shapes / 4 body parts /
 * 4 accessories, sourced from the original LaoA-GrokBot project (MIT).
 *
 * Expression data lives in ./expressions.json and is imported at build time.
 *
 * @module dsh-grokbot-pet/client/data
 */

/** [id, displayName, hex] */
export type ColorTuple = [string, string, string]
/** [id, displayName, svgPath] */
export type ShapeTuple = [string, string, string]
/** [id, displayName, icon] */
export type ToggleTuple = [string, string, string]

export const COLORS: ColorTuple[] = [
  ['cocoa',  '可可棕', '#9a6737'],
  ['red',    '活力红', '#ff3347'],
  ['orange', '暖橙',   '#ff6a00'],
  ['amber',  '琥珀',   '#ff9800'],
  ['green',  '青绿',   '#08c77a'],
  ['teal',   '湖蓝',   '#08b9a9'],
  ['blue',   '经典蓝', '#2f86ed'],
  ['purple', '梦幻紫', '#8656f6'],
  ['pink',   '桃粉',   '#ff2d8b'],
  ['black',  '纯黑',   '#000000'],
]

export const SHAPES: ShapeTuple[] = [
  ['blob',     '原始形态', 'M228.541 114.228C228.541 130.133 225.184 145.994 218.738 160.534C212.674 174.217 203.904 186.669 193.065 196.988C155.933 232.34 99.497 238.596 55.5255 212.24C45.097 205.99 35.6851 198.072 27.7451 188.866C19.1926 178.953 12.3686 167.569 7.65781 155.351C2.60712 142.264 0 128.257 0 114.228C0 98.3219 3.35751 82.4611 9.80315 67.9215C15.8672 54.2382 24.6377 41.7862 35.4767 31.4668C72.6081 -3.88483 129.044 -10.1413 173.016 16.2153C183.444 22.4653 192.856 30.3829 200.796 39.5896C209.349 49.5018 216.173 60.8859 220.883 73.1037C225.934 86.1906 228.541 100.198 228.541 114.228Z'],
  ['pebble',   '鹅卵石',   'M114 8C177 8 217 45 217 109C217 178 181 219 112 219C43 219 12 181 12 113C12 48 51 8 114 8Z'],
  ['squircle', '圆角方',   'M55 10H174Q219 10 219 55V174Q219 219 174 219H55Q10 219 10 174V55Q10 10 55 10Z'],
  ['capsule',  '胶囊',     'M61 31H168C202 31 220 65 220 114C220 163 202 197 168 197H61C27 197 9 163 9 114C9 65 27 31 61 31Z'],
  ['triangle', '三角体',   'M114 9Q122 9 128 21L220 194Q227 210 207 210H21Q1 210 9 194L101 21Q106 9 114 9Z'],
  ['hex',      '六边体',   'M114 5L207 58Q218 64 218 78V153Q218 167 207 173L128 218Q114 226 100 218L21 173Q10 167 10 153V78Q10 64 21 58L100 12Q114 5 114 5Z'],
  ['cloud',    '云朵',     'M55 188C21 188 6 169 12 142C-1 113 20 86 51 84C61 48 96 35 124 55C151 28 195 46 195 82C226 91 235 128 213 149C214 174 193 190 165 188Z'],
  ['drop',     '水滴',     'M114 5C137 42 202 103 202 151C202 196 165 222 114 222C63 222 26 196 26 151C26 103 91 42 114 5Z'],
]

export const PARTS: ToggleTuple[] = [
  ['hands',   '双手', '⌁'],
  ['feet',    '双脚', '⌄'],
  ['tail',    '尾巴', '〜'],
  ['antenna', '天线', '⌃'],
]

export const ACCESSORIES: ToggleTuple[] = [
  ['straw-hat', '草帽',   '◒'],
  ['glasses',   '眼镜',   '◎'],
  ['bowtie',    '蝴蝶结', '⋈'],
  ['cape',      '披风',   '◢'],
]

export interface AppearanceState {
  shape: string
  color: string
  accessories: string[]
  parts: string[]
  /** 宠物名字：点击宠物时气泡标题与提示文字。 */
  name: string
  /** 始终注视鼠标：即使鼠标不悬停在宠物身上，眼睛也跟随鼠标。 */
  gazeAlways: boolean
}

export const DEFAULT_APPEARANCE: AppearanceState = {
  shape: 'blob',
  color: '#2f86ed',
  accessories: [],
  parts: [],
  name: 'DSH 桌宠',
  gazeAlways: true,
}
