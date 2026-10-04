/** Native event and form contracts are retained while Ant Design supplies the controls. */
import { Button as AntButton, Input as AntInput } from 'antd';
import type { ButtonProps, InputProps } from 'antd';
import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function Button(
  { type = 'submit', className = '', ...props },
  ref,
) {
  return (
    <AntButton
      {...(props as ButtonProps)}
      ref={ref}
      htmlType={type}
      className={className}
      autoInsertSpace={false}
      type={className.includes('primary-button') ? 'primary' : className.includes('link-button') ? 'link' : 'default'}
      danger={className.includes('danger-button')}
    />
  );
});

const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { type, size, ...props },
  ref,
) {
  const inputRef = useRef<React.ComponentRef<typeof AntInput>>(null);
  useImperativeHandle(ref, () => inputRef.current!.input!, []);
  return (
    <AntInput
      {...(props as InputProps)}
      {...(size !== undefined ? { htmlSize: size } : {})}
      {...(type !== undefined ? { type } : {})}
      ref={inputRef}
    />
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(props, ref) {
  // Native file/selection controls retain their validation, checked and ref contracts.
  if (props.type === 'file' || props.type === 'checkbox' || props.type === 'radio')
    return <input {...props} ref={ref} />;
  return <TextInput {...props} ref={ref} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea(props, ref) {
    const inputRef = useRef<React.ComponentRef<typeof AntInput.TextArea>>(null);
    useImperativeHandle(ref, () => inputRef.current!.resizableTextArea!.textArea, []);
    return <AntInput.TextArea {...(props as React.ComponentProps<typeof AntInput.TextArea>)} ref={inputRef} />;
  },
);
