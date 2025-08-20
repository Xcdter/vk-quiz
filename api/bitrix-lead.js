/**
 * Vercel Serverless function
 * POST /api/bitrix-lead
 *
 * Body JSON:
 * {
 *   "name": "Имя",
 *   "phone": "+79001234567",
 *   "answers": {
 *     "sposob_svyazi": "Телеграм",
 *     "forma": "Прямая",
 *     "style": "Фасады с декором",
 *     "razmer": "10 - 15 метров²",
 *     "sroki": "От 2 до 4 месяцев",
 *     "budget": "200 - 300 тыс рублей",
 *     "podarok": "Вытяжка"
 *   }
 * }
 */

const WEBHOOK = process.env.BITRIX_WEBHOOK_URL;
// Пример: https://*.bitrix24.ru/rest/XXX/XXXXXXXXXXXXXX/

// Универсальный вызов REST Битрикса с логами
async function bx(method, payload = {}) {
  const url = `${WEBHOOK}${method}.json`;
  console.log(`[BX] call → ${method}`, JSON.stringify(payload).slice(0, 1000));

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=utf-8" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error(`[BX] HTTP ${resp.status}`, data);
    throw new Error(`Bitrix HTTP ${resp.status}`);
  }
  if (data.error) {
    console.error(`[BX] ${method} error:`, data);
    throw new Error(data.error_description || data.error);
  }

  console.log(`[BX] ${method} ok`);
  return data.result;
}

// Получаем карту UF-полей сделки: XML_ID → FIELD_NAME (например "UF_CRM_SROKI")
async function getDealUFMap() {
  const fields = await bx("crm.deal.userfield.list", {});

  // Лог только ключи и важные части
  console.log(
    "[UF_MAP] raw count:",
    Array.isArray(fields) ? fields.length : "n/a"
  );

  const map = {};
  (fields || []).forEach((f) => {
    // f: { FIELD_NAME, XML_ID, ... }
    if (f && f.FIELD_NAME && f.XML_ID) {
      map[f.XML_ID] = f.FIELD_NAME;
    }
  });

  console.log("[UF_MAP] built:", map);
  return map;
}

// Поиск контакта по телефону (упрощённо)
async function findContactByPhone(phone) {
  // Иногда удобнее нормализовать телефон:
  const normalized = String(phone || "").replace(/[^\d+]/g, "");
  console.log("[CONTACT] find by phone:", normalized);

  const res = await bx("crm.contact.list", {
    filter: { PHONE: normalized },
    select: ["ID", "NAME", "PHONE"],
  });

  // Возвращаем первый найденный ID, если есть
  const id = Array.isArray(res) && res.length ? res[0].ID : null;
  console.log("[CONTACT] found ID:", id || "none");
  return id;
}

// Создание контакта
async function createContact(name, phone) {
  console.log("[CONTACT] create:", { name, phone });

  const id = await bx("crm.contact.add", {
    fields: {
      NAME: name || "Без имени",
      PHONE: [{ VALUE: phone || "", VALUE_TYPE: "WORK" }],
    },
  });

  console.log("[CONTACT] created ID:", id);
  return id;
}

// Создание сделки
async function createDeal({ title, contactId, ufFields }) {
  const fields = {
    TITLE: title || "Новая заявка",
    ...(contactId ? { CONTACT_ID: contactId } : {}),
    ...(ufFields || {}),
  };

  console.log("[DEAL] create fields:", fields);

  const id = await bx("crm.deal.add", {
    fields,
    params: { REGISTER_SONET_EVENT: "Y" },
  });

  console.log("[DEAL] created ID:", id);
  return id;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method Not Allowed" });
      return;
    }
    if (!WEBHOOK) {
      res
        .status(500)
        .json({ ok: false, error: "BITRIX_WEBHOOK_URL is not set" });
      return;
    }

    const body = await (async () => {
      try {
        return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      } catch (e) {
        return {};
      }
    })();

    const name = (body?.name || "").toString().trim();
    const phone = (body?.phone || "").toString().trim();
    const answers = body?.answers || {};

    console.log(
      "incoming payload:",
      JSON.stringify({ name, phone, answers }, null, 2)
    );

    if (!phone) {
      res.status(400).json({ ok: false, error: "phone is required" });
      return;
    }

    // 1) Контакт
    let contactId = await findContactByPhone(phone);
    if (!contactId) {
      contactId = await createContact(name, phone);
    }

    // 2) Карта UF полей сделки (XML_ID → UF_CRM_*)
    const UF_MAP = await getDealUFMap();

    // 3) Собираем UF-поля из answers по их XML_ID
    //    Т.к. твои поля — строковые, просто кладём строку.
    const ufFields = {};
    for (const [xmlId, valueRaw] of Object.entries(answers || {})) {
      if (valueRaw == null || String(valueRaw).trim() === "") continue;

      const ufName = UF_MAP[xmlId]; // например "UF_CRM_SROKI"
      if (!ufName) {
        console.warn(`[UF_MAP] no match for XML_ID "${xmlId}" — пропущено`);
        continue;
      }

      ufFields[ufName] = String(valueRaw);
    }

    console.log("[DEAL] UF fields resolved:", ufFields);

    // 4) Создаём сделку
    const dealId = await createDeal({
      title: `Новая заявка от ${name || phone}`,
      contactId,
      ufFields,
    });

    res.status(200).json({
      ok: true,
      dealId,
      contactId,
      sentUF: ufFields,
      note:
        "Если какие-то UF-поля не заполнились — проверь, что XML_ID в answers совпадает с XML_ID полей в Битриксе (CRM → Настройки → Пользовательские поля → Сделки).",
    });
  } catch (e) {
    console.error("bitrix-lead fatal:", e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
