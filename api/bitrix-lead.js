// /api/bitrix-lead.js
// Создаёт сделку в Битрикс24, заполняя UF-поля по XML_ID, и привязывает контакт.
// Ожидаемый payload (JSON, POST):
// {
//   "name": "Имя",
//   "phone": "+79991234567",
//   "answers": {
//     "sposob_svyazi": "Телефон",
//     "forma": "П-образная",
//     "style": "Ещё не определились",
//     "razmer": "10 - 15 метров²",
//     "sroki": "От 2 до 4 месяцев",
//     "budget": "130 - 200 тысяч рублей",
//     "podarok": "Подсветка",
//     "vopros": "— по желанию —"
//   },
//   "utm": { "utm_source": "...", "utm_campaign": "..." },
//   "vk_user_id": 123456789
// }

const RAW = process.env.BITRIX_WEBHOOK_URL || '';
const ROOT = RAW
  .replace(/(crm\.[\w.]+\.json)?$/i, '') // если вдруг в переменную попал метод
  .replace(/\/?$/, '/');                  // гарантируем ровно один завершающий слэш

async function call(method, payload = {}) {
  const url = `${ROOT}${method}.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });

  let data;
  try {
    data = await resp.json();
  } catch {
    const txt = await resp.text();
    console.error('Bitrix raw response:', txt, 'URL:', url);
    throw new Error('Bitrix JSON parse error');
  }

  if (data.error) {
    console.error('bitrix error:', data.error, data.error_description, 'URL:', url, 'payload:', payload);
    throw new Error(data.error_description || data.error);
  }
  return data.result;
}

// Кэш соответствий XML_ID -> UF_CRM_* для CRM_DEAL
let UF_MAP_CACHE = null;
async function getUFMapForDeals() {
  if (UF_MAP_CACHE) return UF_MAP_CACHE;

  let fields;
  try {
    // Нормальный путь
    fields = await call('crm.deal.userfield.list', { select: ['FIELD_NAME', 'XML_ID', 'LIST'] });
  } catch (e) {
    // Фоллбэк для редких порталов
    if (String(e.message).includes('Method not found')) {
      fields = await call('crm.userfield.list', {
        filter: { ENTITY_ID: 'CRM_DEAL' },
        select: ['FIELD_NAME', 'XML_ID', 'LIST'],
      });
    } else {
      throw e;
    }
  }

  const map = {};          // XML_ID -> UF_CRM_...
  const enums = {};        // XML_ID -> { TITLE -> ID } (на случай enum-полей)
  for (const f of fields || []) {
    if (f.XML_ID && f.FIELD_NAME) map[f.XML_ID] = f.FIELD_NAME;
    if (f.XML_ID && Array.isArray(f.LIST) && f.LIST.length) {
      const dict = {};
      for (const item of f.LIST) {
        if (item && item.ID && item.VALUE) dict[String(item.VALUE).trim()] = item.ID;
      }
      enums[f.XML_ID] = dict;
    }
  }

  UF_MAP_CACHE = { map, enums };
  return UF_MAP_CACHE;
}

function normPhone(raw) {
  if (!raw) return '';
  let v = String(raw).trim();
  const hasPlus = v.startsWith('+');
  v = (hasPlus ? '+' : '') + v.replace(/[^\d]/g, '');
  if (v.startsWith('00')) v = '+' + v.slice(2);
  let d = v.replace(/\D/g, '');
  if (!hasPlus && d.length === 11 && d[0] === '8') { d = '7' + d.slice(1); v = '+' + d; }
  if (!v.startsWith('+')) v = '+' + d;
  return v;
}

function pushLine(arr, k, v) {
  if (v != null && String(v).trim() !== '') arr.push(`${k}: ${v}`);
}

function buildComment({ answers = {}, name, phone, utm = {}, vk_user_id }) {
  // человеко-читаемые подписи под ключи квиза
  const labels = {
    style: 'Стиль',
    forma: 'Планировка',
    razmer: 'Площадь',
    sroki: 'Срок',
    budget: 'Бюджет',
    podarok: 'Подарок',
    sposob_svyazi: 'Способ связи',
    vopros: 'Вопрос/Комментарий',
  };

  const lines = [];
  pushLine(lines, 'Имя', name);
  pushLine(lines, 'Телефон', phone);
  for (const [k, label] of Object.entries(labels)) {
    if (answers[k]) pushLine(lines, label, answers[k]);
  }
  if (vk_user_id) pushLine(lines, 'VK user id', vk_user_id);
  if (utm.utm_source) pushLine(lines, 'UTM source', utm.utm_source);
  if (utm.utm_campaign) pushLine(lines, 'UTM campaign', utm.utm_campaign);
  return lines.join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  if (!ROOT) return res.status(500).json({ ok: false, error: 'BITRIX_WEBHOOK_URL not set' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const answers = body.answers || {};
    const name    = body.name || body.client_name || '';
    let phone     = body.phone || body.client_phone || '';
    const utm     = body.utm || {};
    const vk_user_id = body.vk_user_id || null;

    // нормализуем телефон
    phone = normPhone(phone || answers.phone || '');

    console.log('incoming payload:', JSON.stringify({ name, phone, answers }));

    // получим карту UF полей
    const { map: UF_MAP, enums: ENUM_MAP } = await getUFMapForDeals();

    // соберём UF-поля сделки по XML_ID
    const ufFields = {};
    for (const [xmlId, valRaw] of Object.entries(answers)) {
      if (valRaw == null || String(valRaw).trim() === '') continue;
      const ufName = UF_MAP[xmlId];                 // например, UF_CRM_1723...
      if (!ufName) continue;

      // если поле — ENUM и у нас есть словарь значений, подставим ID
      const dict = ENUM_MAP[xmlId];
      if (dict && typeof valRaw === 'string') {
        const trimmed = valRaw.trim();
        if (dict[trimmed]) {
          ufFields[ufName] = dict[trimmed];
          continue;
        }
      }
      // иначе запишем как строку
      ufFields[ufName] = String(valRaw);
    }

    // создаём/ищем контакт и привязываем
    let contactId = null;
    if (name || phone) {
      try {
        // сначала попробуем найти по телефону
        if (phone) {
          const found = await call('crm.contact.list', {
            filter: { PHONE: phone },
            select: ['ID'],
          });
          if (Array.isArray(found) && found.length) {
            contactId = found[0].ID;
          }
        }
        // если не нашли — создадим
        if (!contactId) {
          contactId = await call('crm.contact.add', {
            fields: {
              NAME: name || 'Клиент',
              PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: 'WORK' }] : [],
            },
          });
        }
      } catch (e) {
        console.warn('contact create/find failed:', e.message || e);
      }
    }

    // соберём поля сделки
    const dealFields = {
      TITLE: name ? `Заявка из квиза — ${name}` : 'Заявка из квиза',
      COMMENTS: buildComment({ answers, name, phone, utm, vk_user_id }),
      SOURCE_ID: 'WEB',
      ASSIGNED_BY_ID: process.env.BITRIX_ASSIGNED_ID || undefined,
      CATEGORY_ID: process.env.BITRIX_CATEGORY_ID != null ? Number(process.env.BITRIX_CATEGORY_ID) : undefined,
      STAGE_ID: process.env.BITRIX_STAGE_ID || undefined,
      CONTACT_ID: contactId || undefined,
      ...ufFields, // UF_CRM_* поля
    };

    // создаём сделку
    const dealId = await call('crm.deal.add', { fields: dealFields, params: { REGISTER_SONET_EVENT: 'Y' } });

    // на некоторых порталах полезно продублировать явную привязку контакта
    if (contactId) {
      try {
        await call('crm.deal.contact.add', { id: dealId, fields: { CONTACT_ID: contactId } });
      } catch (e) {
        console.warn('deal.contact.add warning:', e.message || e);
      }
    }

    res.status(200).json({ ok: true, dealId, contactId: contactId || null, sent: dealFields });
  } catch (e) {
    console.error('bitrix-deal error:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
