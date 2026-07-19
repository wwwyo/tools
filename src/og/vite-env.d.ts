/// <reference types="vite/client" />

// ogPlugin の resolveId/load が提供する virtual module。デモページ (main.tsx) が
// 実際に生成されるカード一覧をそのまま描画するために使う
declare module 'virtual:og-cards' {
  export type OgCard = {
    name: string;
    // トップページは一覧の 1 件ではないので持たない
    number?: string;
    title: string;
    description: string;
  };
  export const ogCards: OgCard[];
}
