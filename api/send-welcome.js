// /api/send-welcome.js
// Отправляет первое сообщение от имени сообщества со сводкой ответов и 3 кнопками-ссылками.
//
// Требуется переменная окружения VK_GROUP_TOKEN (токен сообщества с правами "messages").
// Дополнительно можно задать VK_PROJECTS_URL / VK_REVIEWS_URL / VK_ERRORS_URL,
// если ссылки на разделы отличаются от дефолтных.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const token = process.env.VK_GROUP_TOKEN;
    if (!token) {
      return res
        .status(500)
        .json({ ok: false, error: "VK_GROUP_TOKEN is not set in environment" });
    }

    const { user_id, group_id, answers = {} } = req.body || {};
    if (!user_id || !group_id) {
      return res
        .status(400)
        .json({ ok: false, error: "user_id и group_id обязательны" });
    }

    // Базовая ссылка на сообщество
    const base = `https://vk.com/public${group_id}`;

    // Позволяем переопределить разделы через переменные окружения
    const PROJECTS_URL = process.env.VK_PROJECTS_URL || base; // укажи точный раздел
    const REVIEWS_URL =
      process.env.VK_REVIEWS_URL || base; // укажи точный раздел "Отзывы"
    const ERRORS_URL =
      process.env.VK_ERRORS_URL || base; // укажи нужный раздел "Ошибки/FAQ"

    // Хелпер вызова VK API
    const vkCall = async (method, paramsObj) => {
      const params = new URLSearchParams({ v: "5.199", access_token: token });
      for (const [k, v] of Object.entries(paramsObj)) params.append(k, String(v));
      const resp = await fetch("https://api.vk.com/method/" + method, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const json = await resp.json();
      if (json.error) throw new Error(json.error.error_msg || method);
      return json.response;
    };

    // (Опционально) проверим, разрешены ли сообщения от сообщества
    try {
      const allowed = await vkCall("messages.isMessagesFromGroupAllowed", {
        user_id,
        group_id,
      });
      if (allowed && allowed.is_allowed !== 1) {
        return res.status(403).json({
          ok: false,
          error:
            "Пользователь не дал разрешение на сообщения от сообщества (AllowMessages).",
        });
      }
    } catch {
      // Если метод недоступен — продолжаем, обычно всё равно отправится, если юзер уже дал разрешение
    }

    // Собираем сводку по ответам (подставляем только те, что есть)
    const labels = {
      style: "Стиль",
      layout: "Планировка",
      area: "Площадь",
      deadline: "Срок",
      budget: "Бюджет",
      gift: "Подарок",
      method: "Связь",
      name: "Имя",
      phone_e164: "Телефон",
    };

    const lines = ["Спасибо! Мы получили вашу заявку по кухне."];
    for (const [k, label] of Object.entries(labels)) {
      if (answers?.[k]) lines.push(`${label}: ${answers[k]}`);
    }
    const messageText = lines.join("\n");

    // Клавиатура с тремя кнопками — открывают нужные разделы
    const keyboard = {
      inline: true,
      buttons: [
        [
          {
            action: {
              type: "open_link",
              link: PROJECTS_URL,
              label: "Наши проекты",
            },
          },
          {
            action: {
              type: "open_link",
              link: REVIEWS_URL,
              label: "Отзывы",
            },
          },
          {
            action: {
              type: "open_link",
              link: ERRORS_URL,
              label: "Ошибки",
            },
          },
        ],
      ],
    };

    // Отправляем сообщение
    const resp = await vkCall("messages.send", {
      user_id,
      random_id: Date.now(),
      message: messageText,
      keyboard: JSON.stringify(keyboard),
    });

    return res.status(200).json({ ok: true, result: resp });
  } catch (e) {
    console.error("send-welcome error:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
