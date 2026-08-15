/**
 * The small controls every panel is built from.
 *
 * `NumberField` keeps its own text while the field has focus and commits on blur or
 * Enter: reformatting a half-typed "1." from the store on every keystroke makes a
 * number impossible to type.
 */

import { useId, type ReactNode } from 'react';
import { parseNumber } from '../state/format';

export interface NumberFieldProps {
  label?: string;
  value: number;
  onCommit(value: number): void;
  step?: number;
  min?: number;
  max?: number;
  /** Shown after the input — the unit the number is in. */
  suffix?: string;
  precision?: number;
  disabled?: boolean;
  title?: string;
  placeholder?: string;
}

/**
 * Uncontrolled while it has focus, so a half-typed "1." is never reformatted out
 * from under the cursor; the `key` remounts it when the value changes elsewhere.
 * Commits on blur and on Enter, reverts on Escape.
 */
export function NumberField({
  label,
  value,
  onCommit,
  step,
  min,
  max,
  suffix,
  precision = 4,
  disabled,
  title,
  placeholder,
}: NumberFieldProps) {
  const id = useId();
  const text = display(value, precision);

  const commit = (input: HTMLInputElement) => {
    const parsed = parseNumber(input.value);
    if (parsed === null) {
      input.value = text;
      return;
    }
    const clamped = clamp(parsed, min, max);
    input.value = display(clamped, precision);
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <label className="field" htmlFor={id} title={title}>
      {label ? <span className="field-label">{label}</span> : null}
      <span className="field-input">
        <input
          key={text}
          id={id}
          type="text"
          inputMode="decimal"
          defaultValue={text}
          step={step}
          disabled={disabled}
          placeholder={placeholder}
          onBlur={(event) => commit(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              event.currentTarget.value = text;
              event.currentTarget.blur();
            }
          }}
        />
        {suffix ? <span className="field-suffix">{suffix}</span> : null}
      </span>
    </label>
  );
}

export interface SelectFieldProps<T extends string> {
  label?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; group?: string }>;
  onChange(value: T): void;
  disabled?: boolean;
  title?: string;
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  title,
}: SelectFieldProps<T>) {
  const id = useId();
  const groups = new Map<string, Array<{ value: T; label: string }>>();
  for (const option of options) {
    const key = option.group ?? '';
    const bucket = groups.get(key);
    if (bucket) bucket.push(option);
    else groups.set(key, [option]);
  }

  return (
    <label className="field" htmlFor={id} title={title}>
      {label ? <span className="field-label">{label}</span> : null}
      <span className="field-input">
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {[...groups.entries()].map(([group, entries]) =>
            group === '' ? (
              entries.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))
            ) : (
              <optgroup key={group} label={group}>
                {entries.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ),
          )}
        </select>
      </span>
    </label>
  );
}

export interface CheckFieldProps {
  label: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  title?: string;
}

export function CheckField({ label, checked, onChange, disabled, title }: CheckFieldProps) {
  return (
    <label className="check" title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export interface SliderFieldProps {
  label?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(value: number): void;
  disabled?: boolean;
  title?: string;
}

export function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  disabled,
  title,
}: SliderFieldProps) {
  const id = useId();
  return (
    <label className="field slider" htmlFor={id} title={title}>
      {label ? <span className="field-label">{label}</span> : null}
      <input
        id={id}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step ?? ((max - min) / 200 || 0.001)}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export interface ButtonGroupOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

export interface ButtonGroupProps<T extends string> {
  value: T;
  options: ReadonlyArray<ButtonGroupOption<T>>;
  onChange(value: T): void;
  disabled?: boolean;
}

export function ButtonGroup<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: ButtonGroupProps<T>) {
  return (
    <div className="button-group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          disabled={disabled}
          className={option.value === value ? 'on' : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="hint">{children}</p>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

function display(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '';
  const scale = 10 ** precision;
  return String(Math.round(value * scale) / scale);
}

function clamp(value: number, min?: number, max?: number): number {
  let result = value;
  if (min !== undefined && result < min) result = min;
  if (max !== undefined && result > max) result = max;
  return result;
}
