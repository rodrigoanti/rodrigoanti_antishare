import type { ButtonHTMLAttributes, ReactElement } from 'react'
import styles from './MachineCard.module.css'
import { cx } from '../utils/cx'

export interface MachineCardProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  name: string
  online: boolean
  selected?: boolean
  tokenRequired?: boolean
}

export function MachineCard({
  name,
  online,
  selected = false,
  tokenRequired = false,
  ...rest
}: MachineCardProps): ReactElement {
  return (
    <button
      type="button"
      className={cx(styles.card, selected && styles.selected)}
      aria-pressed={selected}
      {...rest}
    >
      <span className={styles.name}>{name}</span>
      <span className={cx(styles.status, online && styles.statusOnline)}>
        <span className={cx(styles.dot, online && styles.dotOn)} aria-hidden="true" />
        {online ? 'En línea' : 'Inactivo'}
      </span>
      {tokenRequired && <span className={styles.badge}>Token</span>}
    </button>
  )
}
