/**
 * dsh-grokbot-pet — Client entry.
 *
 * Pure client-side plugin: no Host half, no Remote calls. The pet reads the
 * active Session through `ctx.sessions` and derives running / tool / step /
 * turn state from it. That bridge supports both client generations (browser
 * Web 0.1.x ConversationSnapshot and Desktop / Web 0.2.x Session event
 * window); see `store.ts`. GrokBot expression data is bundled as a JSON module
 * (no runtime fs read).
 *
 * @module dsh-grokbot-pet/client
 */
import { createElement, type ReactNode } from 'react'
import { createPetStateStore, type SessionSourceLike } from './store.ts'
import { PetView, PetSettingsPage } from './pet.tsx'

/** Slot registration definition accepted by dsh-client-ui-slots (0.1.x/0.2.x). */
interface SlotDefinition {
  name: string
  id?: string
  order?: number
  priority?: number
  label?: () => string
  locale?: string
}

/** The subset of the client root context this plugin uses, across generations. */
export interface ClientContextLike {
  sessions: SessionSourceLike
  effect(callback: () => () => void, label?: string): void
  slots: {
    inject(name: string, callback: () => (() => void) | void): void
    register(definition: SlotDefinition, view: (props: unknown) => ReactNode): () => void
  }
}

export const inject = ['slots', 'sessions', 'timer'] as const

export function apply(ctx: ClientContextLike): void {
  const store = createPetStateStore(ctx.sessions)

  ctx.effect(() => () => { store.dispose() }, 'ui-pet: dispose store')

  // Pet overlay in the frame-wide floating layer
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'dsh-pet', order: 900, label: () => 'DSH 桌宠' },
    () => createElement(PetView, { store, ctx }),
  ))

  // Appearance settings page (sidebar → settings → section)
  ctx.slots.inject('sidebar.settings', () => {
    ctx.slots.inject('settings.section', () => ctx.slots.register(
      { name: 'settings.section', id: 'dsh-pet-appearance', order: 900, label: () => '桌宠外观' },
      () => createElement(PetSettingsPage),
    ))
    return () => {}
  })
}
