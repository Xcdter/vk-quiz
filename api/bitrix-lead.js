// /api/bitrix-lead.js

export const config = {
  runtime: "edge",
};

const WEBHOOK = process.env.BITRIX_WEBHOOK_URL; // например: https://yourportal.bitrix24.ru/rest/679/XXXXXX/

function json(res, status = 200) {
  return new Response(JSON.stringify(res, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function bxCall(method, params = {}) {
  const url = `${WEBHOOK}${method}.json`;
  const body = JSON.stringify(params);
  console.log(`[BX] call -> ${method}`, body);

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    console.error(`[BX] ERROR ${method}`, r.status, data);
    throw new Error(
      data?.error_description || data?.error || `Bitrix call failed: ${method}`
    );
  }
  console.log(`[BX] ok <- ${method}`);
  return data.result;
}

// Телефон к формату +7XXXXXXXXXX (очень простая нормализация)
function normalizePhone(raw) {
  if (!raw) return "";
  let p = String(raw).replace(/[^\d+]/g, "");
  // Если начинается на 8 и 11 цифр — заменим на +7
  if (/^8\d{10}$/.test(p)) p = `+7${p.slice(1)}`;
  // Если начинается на 7 и 11 цифр — поставим плюс
  if (/^7\d{10}$/.test(p)) p = `+${p}`;
  // Если нет плюса и 11/10 цифр — просто добавим плюс (как есть)
  if (!p.startsWith("+")) p = `+${p}`;
  return p;
}

// 1) Найти контакт по телефону, либо создать
async function findOrCreateContact(name, phone) {
  const normPhone = normalizePhone(phone);
  console.log(`[CONTACT] search by phone: ${normPhone}`);

  const list = await bxCall("crm.contact.list", {
    filter: { PHONE: normPhone },
    select: ["ID", "NAME"],
  });

  if (Array.isArray(list) && list.length > 0) {
    const id = list[0].ID;
    console.log(`[CONTACT] found ID: ${id}`);
    return id;
  }

  console.log(`[CONTACT] not found, create new`);
  const contactId = await bxCall("crm.contact.add", {
    fields: {
      NAME: name || "",
      PHONE: [{ VALUE: normPhone, VALUE_TYPE: "WORK" }],
    },
    params: { REGISTER_SONET_EVENT: "Y" },
  });

  console.log(`[CONTACT] created ID: ${contactId}`);
  return contactId;
}

// 2) Маппинг ключей ответов квиза → UF_CRM_* поля
const FIELD_MAP = {
  // ключ из payload.answers -> XML_ID пользовательского поля сделки
  sposob_svyazi: "UF_CRM_SPOSOBSVYAZI",
  forma: "UF_CRM_FORMA",
  style: "UF_CRM_STYLE",
  razmer: "UF_CRM_RAZMER",
  sroki: "UF_CRM_SROKI",
  budget: "UF_CRM_BUDGET",
  podarok: "UF_CRM_PODAROK",
};

// 3) Преобразовать ответы в структуру UF полей сделки
function buildUFFields(answers = {}) {
  const uf = {};
  const entries = Object.entries(answers || {});
  console.log(`[UF_MAP] incoming answers keys:`, entries.map(([k]) => k));

  for (const [key, value] of entries) {
    const xml = FIELD_MAP[key];
    if (!xml) {
      console.warn(`[UF_MAP] no match for key "${key}" -> пропущено`);
      continue;
    }
    uf[xml] = value;
    console.log(`[UF_MAP] mapped ${key} -> ${xml} = "${value}"`);
  }
  console.log(`[UF_MAP] result fields:`, uf);
  return uf;
}

// 4) Создание сделки
async function createDeal({ title, contactId, answers }) {
  const uf = buildUFFields(answers);
  const fields = {
    TITLE: title,
    CONTACT_ID: contactId,
    ...uf,
  };

  console.log("[DEAL] create fields:", fields);

  const dealId = await bxCall("crm.deal.add", {
    fields,
    params: { REGISTER_SONET_EVENT: "Y" },
  });

  console.log(`[DEAL] created ID: ${dealId}`);
  return dealId;
}

// ----------------- handler -----------------
export default async function handler(req) {
  try {
    if (req.method !== "POST") {
      return json({ ok: false, error: "Method Not Allowed" }, 405);
    }
    if (!WEBHOOK) {
      console.error("BITRIX_WEBHOOK_URL is not set");
      return json({ ok: false, error: "Server misconfigured: no webhook" }, 500);
    }

    const payload = await req.json();
    console.log("incoming payload:", payload);

    const name = (payload?.name || "").toString().trim() || "Без имени";
    const phone = (payload?.phone || "").toString().trim();
    const answers = payload?.answers || {};

    if (!phone) {
      return json({ ok: false, error: "Phone is required" }, 400);
    }

    // 1) CONTACT
    const contactId = await findOrCreateContact(name, phone);

    // 2) DEAL
    const dealTitle = `Новая заявка от ${name}`;
    const dealId = await createDeal({
      title: dealTitle,
      contactId,
      answers,
    });

    return json({ ok: true, contactId, dealId });
  } catch (e) {
    console.error("bitrix-lead error:", e);
    return json({ ok: false, error: e?.message || "Unknown error" }, 500);
  }
}
