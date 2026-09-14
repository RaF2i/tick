const AUTH_URL = 'https://admin.catedraldesevilla.servitickets.es/api/places/authenticate';
const CART_URL = 'https://admin.catedraldesevilla.servitickets.es/api/cart/add';

const cartBody = {
  visit_id: 25,
  cart_id: null,
  place_id: '2',
  tour_id: 25,
  timetables: [{ id: 17446 }],
  tickets: [
    {
      id: 34,
      quantity: 22,
    },
  ],
  subject_id: null,
};

async function parseJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error('Non-JSON response (status ' + res.status + '):');
    console.error(text.slice(0, 2000));
    throw e;
  }
}

async function main() {
  const authRes = await fetch(AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ api_key: process.env.SERVITICKETS_API_KEY || '' }),
    redirect: 'manual',
  });
  console.log('Auth status:', authRes.status);
  const authData = await parseJson(authRes);

  if (!authData.success || !authData.token) {
    throw new Error('Auth failed: ' + JSON.stringify(authData));
  }
  console.log('Authenticated. token=' + authData.token);

  const cartRes = await fetch(CART_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer ' + authData.token,
    },
    body: JSON.stringify(cartBody),
  });
  console.log('Cart status:', cartRes.status);
  const cartData = await parseJson(cartRes);
  console.log(JSON.stringify(cartData, null, 2));
  return cartData;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
