import type { ReactElement, SVGProps } from 'react'

export type FileGlyphKind = 'folder' | 'image' | 'document' | 'archive' | 'video' | 'audio' | 'generic'

const IMAGE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'heic',
  'heif',
  'tif',
  'tiff',
  'svg',
  'ico'
])
const DOC_EXT = new Set([
  'pdf',
  'txt',
  'md',
  'rtf',
  'doc',
  'docx',
  'pages',
  'odt',
  'csv',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'key',
  'numbers'
])
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'dmg', 'pkg'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'aac', 'm4a', 'flac', 'aiff', 'ogg'])

export function fileGlyphKind(name: string, isDir: boolean): FileGlyphKind {
  if (isDir) return 'folder'
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return 'generic'
  const ext = name.slice(dot + 1).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (DOC_EXT.has(ext)) return 'document'
  if (ARCHIVE_EXT.has(ext)) return 'archive'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return 'generic'
}

type IconProps = SVGProps<SVGSVGElement> & { size?: 'lg' | 'sm' }

function dims(size: 'lg' | 'sm', w: number, h: number): { width: number; height: number } {
  if (size === 'sm') return { width: Math.round(w * 0.38), height: Math.round(h * 0.38) }
  return { width: w, height: h }
}

export function FolderIcon({ size = 'lg', ...props }: IconProps): ReactElement {
  const { width, height } = dims(size, 80, 64)
  return (
    <svg viewBox="0 0 96 80" width={width} height={height} aria-hidden="true" {...props}>
      <path
        d="M8 18c0-4.4 3.6-8 8-8h18.5c2.1 0 4.1.8 5.6 2.3L46 18.2c1.5 1.5 3.5 2.3 5.6 2.3H80c4.4 0 8 3.6 8 8V62c0 4.4-3.6 8-8 8H16c-4.4 0-8-3.6-8-8V18z"
        fill="#5AC8FA"
      />
      <path d="M8 28h80v34c0 4.4-3.6 8-8 8H16c-4.4 0-8-3.6-8-8V28z" fill="#007AFF" />
      <path d="M8 28h80v6H8z" fill="#0A84FF" opacity="0.55" />
    </svg>
  )
}

export function FileIcon({ size = 'lg', ...props }: IconProps): ReactElement {
  const { width, height } = dims(size, 56, 70)
  return (
    <svg viewBox="0 0 64 80" width={width} height={height} aria-hidden="true" {...props}>
      <path
        d="M12 4h28l16 16v52c0 2.2-1.8 4-4 4H12c-2.2 0-4-1.8-4-4V8c0-2.2 1.8-4 4-4z"
        fill="#F5F5F7"
        stroke="#D2D2D7"
        strokeWidth="2"
      />
      <path d="M40 4v16h16" fill="#E8E8ED" stroke="#D2D2D7" strokeWidth="2" />
    </svg>
  )
}

export function ImageFileIcon({ size = 'lg', ...props }: IconProps): ReactElement {
  const { width, height } = dims(size, 56, 70)
  return (
    <svg viewBox="0 0 64 80" width={width} height={height} aria-hidden="true" {...props}>
      <path
        d="M12 4h28l16 16v52c0 2.2-1.8 4-4 4H12c-2.2 0-4-1.8-4-4V8c0-2.2 1.8-4 4-4z"
        fill="#FFF7ED"
        stroke="#F5A623"
        strokeWidth="2"
      />
      <path d="M40 4v16h16" fill="#FFE8C2" stroke="#F5A623" strokeWidth="2" />
      <circle cx="24" cy="36" r="5" fill="#F5A623" />
      <path d="M14 58l12-14 8 9 6-7 10 12H14z" fill="#FF9F0A" opacity="0.85" />
    </svg>
  )
}

export function DocumentFileIcon({ size = 'lg', ...props }: IconProps): ReactElement {
  const { width, height } = dims(size, 56, 70)
  return (
    <svg viewBox="0 0 64 80" width={width} height={height} aria-hidden="true" {...props}>
      <path
        d="M12 4h28l16 16v52c0 2.2-1.8 4-4 4H12c-2.2 0-4-1.8-4-4V8c0-2.2 1.8-4 4-4z"
        fill="#FFFFFF"
        stroke="#8E8E93"
        strokeWidth="2"
      />
      <path d="M40 4v16h16" fill="#E5E5EA" stroke="#8E8E93" strokeWidth="2" />
      <path d="M18 36h28M18 44h28M18 52h18" stroke="#AEAEB2" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

export function ArchiveFileIcon({ size = 'lg', ...props }: IconProps): ReactElement {
  const { width, height } = dims(size, 56, 70)
  return (
    <svg viewBox="0 0 64 80" width={width} height={height} aria-hidden="true" {...props}>
      <path
        d="M12 4h28l16 16v52c0 2.2-1.8 4-4 4H12c-2.2 0-4-1.8-4-4V8c0-2.2 1.8-4 4-4z"
        fill="#FFF9E6"
        stroke="#C7A000"
        strokeWidth="2"
      />
      <path d="M40 4v16h16" fill="#FFE566" stroke="#C7A000" strokeWidth="2" />
      <rect x="26" y="28" width="12" height="10" rx="1.5" fill="#FFD60A" stroke="#C7A000" strokeWidth="1.5" />
      <rect x="26" y="40" width="12" height="10" rx="1.5" fill="#FFD60A" stroke="#C7A000" strokeWidth="1.5" />
      <rect x="26" y="52" width="12" height="10" rx="1.5" fill="#FFD60A" stroke="#C7A000" strokeWidth="1.5" />
    </svg>
  )
}

export function VideoFileIcon({ size = 'lg', ...props }: IconProps): ReactElement {
  const { width, height } = dims(size, 56, 70)
  return (
    <svg viewBox="0 0 64 80" width={width} height={height} aria-hidden="true" {...props}>
      <path
        d="M12 4h28l16 16v52c0 2.2-1.8 4-4 4H12c-2.2 0-4-1.8-4-4V8c0-2.2 1.8-4 4-4z"
        fill="#F3E8FF"
        stroke="#AF52DE"
        strokeWidth="2"
      />
      <path d="M40 4v16h16" fill="#E9D5FF" stroke="#AF52DE" strokeWidth="2" />
      <circle cx="32" cy="46" r="14" fill="#BF5AF2" opacity="0.9" />
      <path d="M28 38v16l14-8z" fill="#FFFFFF" />
    </svg>
  )
}

export function AudioFileIcon({ size = 'lg', ...props }: IconProps): ReactElement {
  const { width, height } = dims(size, 56, 70)
  return (
    <svg viewBox="0 0 64 80" width={width} height={height} aria-hidden="true" {...props}>
      <path
        d="M12 4h28l16 16v52c0 2.2-1.8 4-4 4H12c-2.2 0-4-1.8-4-4V8c0-2.2 1.8-4 4-4z"
        fill="#E8FFF5"
        stroke="#30D158"
        strokeWidth="2"
      />
      <path d="M40 4v16h16" fill="#C8F5D8" stroke="#30D158" strokeWidth="2" />
      <circle cx="26" cy="52" r="8" fill="#30D158" />
      <path d="M34 28v24" stroke="#248A3D" strokeWidth="3" strokeLinecap="round" />
      <path d="M34 28c8 2 12 8 12 14" fill="none" stroke="#248A3D" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function EntryGlyph({
  name,
  kind,
  size = 'lg'
}: {
  name: string
  kind: 'folder' | 'file'
  size?: 'lg' | 'sm'
}): ReactElement {
  const glyph = fileGlyphKind(name, kind === 'folder')
  switch (glyph) {
    case 'folder':
      return <FolderIcon size={size} />
    case 'image':
      return <ImageFileIcon size={size} />
    case 'document':
      return <DocumentFileIcon size={size} />
    case 'archive':
      return <ArchiveFileIcon size={size} />
    case 'video':
      return <VideoFileIcon size={size} />
    case 'audio':
      return <AudioFileIcon size={size} />
    default:
      return <FileIcon size={size} />
  }
}
