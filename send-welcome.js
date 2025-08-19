// /api/send-welcome.js
// Vercel Serverless Function: sends a first message to a user from your VK community.
// Requirements:
//  - Environment variable VK_GROUP_TOKEN: community access token with "messages" permission.
//  - Body JSON: { user_id: number, group_id: number, answers?: object }
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const { user_id, group_id, answers } = req.body || {};
    if (!user_id || !group_id) {
      return res.status(400).json({ ok: false, error: 'user_id and group_id are required' });
    }

    const token = process.env.VK_GROUP_TOKEN;
    if (!token) {
      return res.status(500).json({ ok: false, error: 'VK_GROUP_TOKEN is not set in environment' });
    }

    // Helper for VK API calls
    const vkCall = async (method, paramsObj) => {
      const params = new URLSearchParams({ v: '5.199', access_token: token });
      for (const [k, v] of Object.entries(paramsObj)) params.append(k, String(v));
      const resp = await fetch('https://api.vk.com/method/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const json = await resp.json();
      if (json.error) throw new Error(json.error.error_msg || ('VK API error: ' + method));
      return json.response;
    };

    // 1) Check if user allowed messages from the community
    let allowed;
    try {
      allowed = await vkCall('messages.isMessagesFromGroupAllowed', {
        user_id, group_id
      });
    } catch (e) {
      // If the client has already called VKWebAppAllowMessagesFromGroup, this should pass.
      // If this check fails due to permissions, we can continue to try sending (some portals allow without this check).
      console.warn('isMessagesFromGroupAllowed check failed:', e.message);
    }

    if (allowed && allowed.is_allowed !== 1) {
      return res.status(403).json({ ok: false, error: 'User has not allowed messages from the community' });
    }

    // 2) Build the message text from answers
    const lines = [
      'Спасибо! Мы получили вашу заявку по кухне.',
    ];
    if (answers && typeof answers === 'object') {
      const map = {
        style: 'Стиль',
        layout: 'Планировка',
        area: 'Площадь',
        deadline: 'Сроки',
        budget: 'Бюджет',
        gift: 'Подарок',
        method: 'Метод связи',
        name: 'Имя',
        phone_e164: 'Телефон'
      };
      for (const [k, label] of Object.entries(map)) {
        if (answers[k]) lines.push(`${label}: ${answers[k]}`);
      }
    }
    const messageText = lines.join('\n');

    // 3) Optional: VK keyboard with a quick reply
    const keyboard = {
      one_time: false,
      buttons: [[{
        action: { type: 'text', label: 'Хочу консультацию' },
        color: 'primary'
      }]]
    };

    // 4) Send the message
    const resp = await vkCall('messages.send', {
      user_id,
      random_id: Date.now(), // idempotency
      message: messageText,
      keyboard: JSON.stringify(keyboard)
    });

    return res.status(200).json({ ok: true, result: resp });
  } catch (e) {
    console.error('send-welcome error:', e);
    // Rate limiting (429) or network retries could be implemented here if needed
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
