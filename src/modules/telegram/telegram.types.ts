export interface TelegramUserPayload {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChatPayload {
  id: number | string;
  type?: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
}

export interface TelegramMessagePayload {
  message_id: number;
  from?: TelegramUserPayload;
  chat: TelegramChatPayload;
  date?: number;
  text?: string;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  via_bot?: unknown;
}

export interface TelegramCallbackQueryPayload {
  id: string;
  from: TelegramUserPayload;
  message?: TelegramMessagePayload;
  data?: string;
}

export interface TelegramUpdatePayload {
  update_id?: number | string;
  message?: TelegramMessagePayload;
  edited_message?: TelegramMessagePayload;
  callback_query?: TelegramCallbackQueryPayload;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}
