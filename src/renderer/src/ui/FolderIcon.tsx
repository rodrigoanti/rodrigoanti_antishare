import type { ReactElement, SVGProps } from 'react'

export function FolderIcon(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg
      viewBox="0 0 96 80"
      width="72"
      height="60"
      aria-hidden="true"
      {...props}
    >
      <path
        d="M8 18c0-4.4 3.6-8 8-8h18.5c2.1 0 4.1.8 5.6 2.3L46 18.2c1.5 1.5 3.5 2.3 5.6 2.3H80c4.4 0 8 3.6 8 8V62c0 4.4-3.6 8-8 8H16c-4.4 0-8-3.6-8-8V18z"
        fill="#5AC8FA"
      />
      <path
        d="M8 28h80v34c0 4.4-3.6 8-8 8H16c-4.4 0-8-3.6-8-8V28z"
        fill="#007AFF"
      />
      <path
        d="M8 28h80v6H8z"
        fill="#0A84FF"
        opacity="0.55"
      />
    </svg>
  )
}

export function FileIcon(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg
      viewBox="0 0 64 80"
      width="48"
      height="60"
      aria-hidden="true"
      {...props}
    >
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
