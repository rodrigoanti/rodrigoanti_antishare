import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import styles from './Input.module.css'
import { cx } from '../utils/cx'

type Size = 'sm' | 'md' | 'lg'

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size'> {
  inputSize?: Size
  variant?: 'default' | 'flat'
  invalid?: boolean
  leftIcon?: ReactNode
  rightAddon?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { inputSize = 'md', variant = 'flat', invalid = false, leftIcon, rightAddon, ...rest },
  ref
) {
  return (
    <div
      className={cx(
        styles.wrapper,
        styles[`size-${inputSize}`],
        styles[`variant-${variant}`],
        invalid && styles.invalid,
        rest.disabled && styles.disabled
      )}
    >
      {leftIcon ? <span className={styles.leftIcon}>{leftIcon}</span> : null}
      <input ref={ref} className={styles.input} {...rest} />
      {rightAddon ? <span className={styles.rightAddon}>{rightAddon}</span> : null}
    </div>
  )
})
