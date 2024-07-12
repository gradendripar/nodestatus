import { timingSafeEqual } from 'crypto';
import { Telegraf } from 'telegraf';
import HttpsProxyAgent from 'https-proxy-agent';
import { logger } from '../lib/utils';
import type NodeStatus from '../lib/core';

type PushOptions = {
  bot_token: string;
  chat_id: string[];
  web_hook?: string;
  proxy?: string;
};

export default function usePush(instance: NodeStatus, options: PushOptions) {
  const pushList: Array<(message: string) => void> = [];

  const entities = new Set([
    '_',
    '*',
    '[',
    ']',
    '(',
    ')',
    '~',
    '`',
    '>',
    '#',
    '+',
    '-',
    '=',
    '|',
    '{',
    '}',
    '.',
    '!',
    '\\'
  ]);

  const parseEntities = (msg: any): string => {
    let str: string;
    if (typeof msg !== 'string') str = msg?.toString() || '';
    else str = msg;
    let newStr = '';
    for (const char of str) {
      if (entities.has(char)) {
        newStr += '\\';
      }
      newStr += char;
    }
    return newStr;
  };

  const getBotStatus = (targets: string[]): string => {
    let str = '';
    let total = 0,
      online = 0;
    instance.serversPub.forEach(obj => {
      if (targets.length) {
        if (!targets.some(target => obj.name.toLocaleLowerCase().includes(target))) {
          return;
        }
      }
      total++;
      const item = new Proxy(obj, {
        get(target, key) {
          const value = Reflect.get(target, key);
          return typeof value === 'string' ? parseEntities(value) : value;
        }
      });
      str += `节点名: *${item.name}*\n当前状态: `;
      if (item.status.online4 || item.status.online6) {
        str += '✅*在线*\n';
        online++;
      } else {
        str += '❌*离线*';
        str += '\n\n';
        return;
      }
      str += `负载: ${parseEntities(item.status.load.toFixed(2))} \n`;
      str += `CPU: ${Math.round(item.status.cpu)}% \n`;
      str += `内存: ${Math.round((item.status.memory_used / item.status.memory_total) * 100)}% \n`;
      str += `硬盘: ${Math.round((item.status.hdd_used / item.status.hdd_total) * 100)}% \n`;
      str += '\n';
    });
    return `🍊*NodeStatus* \n🤖 当前有 ${total} 台服务器, 其中在线 ${online} 台\n\n${str}`;
  };

  if (options?.bot_token) {
    const bot = new Telegraf(options.bot_token, {
      ...(options.proxy && {
        telegram: {
          agent: HttpsProxyAgent(options.proxy)
        }
      })
    });

    const chatId = new Set<string>(options.chat_id);

    bot.command('start', ctx => {
      const currentChat = ctx.message.chat.id.toString();
      if (chatId.has(currentChat)) {
        ctx.reply(
          `🍊NodeStatus\n🤖 Hi, this chat id is *${parseEntities(
            currentChat
          )}*\\.\nYou have access to this service\\. I will alert you when your servers changed\\.\nYou are currently using NodeStatus: *${parseEntities(
            process.env.npm_package_version
          )}*`,
          { parse_mode: 'MarkdownV2' }
        );
      } else {
        ctx.reply(
          `🍊NodeStatus\n🤖 Hi, this chat id is *${parseEntities(
            currentChat
          )}*\\.\nYou *do not* have permission to use this service\\.\nPlease check your settings\\.`,
          { parse_mode: 'MarkdownV2' }
        );
      }
    });

    bot.command('status', ctx => {
      const { entities } = ctx.message;
      const msg = ctx.message.text.toLocaleLowerCase().split('');
      if (entities) {
        let len = 0;
        entities.forEach(entity => {
          msg.splice(entity.offset - len, entity.length);
          len += entity.length;
        });
      }
      const targets = msg
        .join('')
        .split(' ')
        .map(item => item.trim())
        .filter(item => item);
      if (chatId.has(ctx.message.chat.id.toString())) {
        ctx.reply(getBotStatus(targets), { parse_mode: 'MarkdownV2' });
      } else {
        ctx.reply('🍊NodeStatus\n*No permission*', { parse_mode: 'MarkdownV2' });
      }
    });

    if (options.web_hook) {
      const secretPath = `/telegraf/${bot.secretPathComponent()}`;
      bot.telegram
        .setWebhook(`${options.web_hook}${secretPath}`)
        .then(() => logger.info('🤖 Telegram Bot is running using webhook'));

      instance.server.on('request', (req, res) => {
        if (
          req.url
          && req.url.length === secretPath.length
          && timingSafeEqual(Buffer.from(secretPath), Buffer.from(req.url))
        ) {
          bot.webhookCallback(secretPath)(req, res);
          res.statusCode = 200;
        }
      });
    } else {
      bot.launch().then(() => logger.info('🤖 Telegram Bot is running using polling'));
    }

    pushList.push(message => [...chatId].map(id => bot.telegram.sendMessage(id, `${message}`, { parse_mode: 'MarkdownV2' })));
  }

  instance.onServerConnected((socket, username) => Promise.all(
    pushList.map(fn => fn(
      `🍊*NodeStatus* \n😀 One new server has connected\\! \n\n *用户名*: ${parseEntities(
        username
      )} \n *节点名*: ${parseEntities(instance.servers[username].name)} \n *时间*: ${parseEntities(new Date())}`
    ))
  ));

  instance.onServerFinish((socket, username) => {
    const now = new Date();
    Promise.all(
      pushList.map(fn => fn(
        `🍊*NodeStatus* \n😰 One server has disconnected\\! \n\n *用户名*: ${parseEntities(
          username
        )} \n *节点名*: ${parseEntities(instance.servers[username]?.name)} \n *时间*: ${parseEntities(now)}`
      ))
    ).then();
  });
}
