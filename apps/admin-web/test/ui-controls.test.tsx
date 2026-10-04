// @vitest-environment jsdom
import { createRef } from 'react';
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Button, Input, TextArea } from '../src/components/ui.js';
afterEach(cleanup);

test('Library controls preserve native form submission and required validation', async () => {
  const user = userEvent.setup();
  let submits = 0;
  render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submits++;
      }}
    >
      <Input aria-label="Email" type="email" required />
      <Button type="submit">Invite</Button>
      <Button type="button">Cancel</Button>
    </form>,
  );
  await user.click(screen.getByRole('button', { name: 'Invite' }));
  assert.equal(submits, 0);
  await user.type(screen.getByRole('textbox'), 'admin@example.test');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  assert.equal(submits, 0);
  await user.click(screen.getByRole('button', { name: 'Invite' }));
  assert.equal(submits, 1);
});

test('Library controls expose real DOM refs for focus recovery and native constraints', () => {
  const input = createRef<HTMLInputElement>();
  const textarea = createRef<HTMLTextAreaElement>();
  const button = createRef<HTMLButtonElement>();
  const checkbox = createRef<HTMLInputElement>();
  const file = createRef<HTMLInputElement>();
  render(
    <>
      <Input ref={input} type="password" autoComplete="new-password" />
      <TextArea ref={textarea} />
      <Button ref={button} type="button">
        Cancel
      </Button>
      <Input type="checkbox" ref={checkbox} disabled />
      <Input type="file" ref={file} accept=".bin" />
    </>,
  );
  assert.equal(input.current?.type, 'password');
  assert.equal(input.current?.autocomplete, 'new-password');
  assert.equal(checkbox.current?.disabled, true);
  assert.equal(file.current?.accept, '.bin');
  textarea.current?.focus();
  assert.equal(document.activeElement, textarea.current);
  button.current?.focus();
  assert.equal(document.activeElement, button.current);
});
