// Plugins record themselves here; main.ts reads it after importing the built entry (F04).
export const PLUGIN_ORDER_SLOT = Symbol.for('@5straps/fixture/plugin-order')

export type PluginOrderSlot = { [PLUGIN_ORDER_SLOT]?: string[] }

export function recordPlugin(nitroApp: object, name: string): void {
  const slot = nitroApp as PluginOrderSlot
  ;(slot[PLUGIN_ORDER_SLOT] ??= []).push(name)
}

export function pluginOrder(nitroApp: object): readonly string[] {
  return (nitroApp as PluginOrderSlot)[PLUGIN_ORDER_SLOT] ?? []
}
