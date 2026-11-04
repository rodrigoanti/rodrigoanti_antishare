import { forwardRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input, type InputProps } from './Input'
import styles from './Input.module.css'

export type PasswordInputProps = Omit<InputProps, 'type' | 'rightAddon'>

/** Password field with a toggle to show what was typed. Starts hidden on every mount. */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput(props, ref) {
    const [visible, setVisible] = useState(false)
    const label = visible ? 'Ocultar clave' : 'Mostrar clave'
    return (
      <Input
        ref={ref}
        {...props}
        type={visible ? 'text' : 'password'}
        rightAddon={
          <button
            type="button"
            className={styles.revealButton}
            aria-label={label}
            aria-pressed={visible}
            title={label}
            disabled={props.disabled}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
          </button>
        }
      />
    )
  }
)
