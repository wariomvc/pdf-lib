export enum IconName {
  Note = '/Comment',
  Help = '/Help',
  Insert = '/Insert',
  Key = '/Key',
  NewParagraph = '/NewParagraph',
  Paragraph = '/Paragraph',
}

export enum AnnotationFlags {
  Invisible = 1 << 0, // 1 (0001)
  Hidden = 1 << 1, // 2 (0010)
  Print = 1 << 2, // 4 (0100)
  NoZoom = 1 << 3, // 8 (1000)
  NoRotate = 1 << 4,
  NoView = 1 << 5,
  ReadOnly = 1 << 6,
  Locked = 1 << 7,
  ToggleNoView = 1 << 8,
  LockedContents = 1 << 9,
}
export type AnnotationFlagType = number;
