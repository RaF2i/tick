# Catedral de Sevilla — Ticketing API

**Base URL:** `https://admin.catedraldesevilla.servitickets.es/api`

---

## 1. Authenticate

`POST /places/authenticate`

**Sent:**
```json
{
  "api_key": "YOUR_API_KEY_HERE"
}
```

**Returned:**
```json
{
  "success": true,
  "message": "Autenticación exitosa",
  "place_id": 2,
  "place_name": "Catedral de Sevilla",
  "token": "266972|nWqs2dSoyAKynKztfRnmTYOtHN7j0Q3Hvdrnnt7Z5a24485e"
}
```

---

## 2. Add Item to Cart

`POST /cart/add` — Bearer token required.

**Sent:**
```json
{
  "visit_id": 25,
  "cart_id": null,
  "place_id": "2",
  "tour_id": 25,
  "timetables": [
    { "id": 7115 }
  ],
  "tickets": [
    {
      "id": 34,
      "name": "Individual adultos",
      "min_tickets": 0,
      "max_tickets": 30,
      "min_other_tickets": 0,
      "parent_ticket_info": {
        "has_dependency": false,
        "parent_ticket": null
      },
      "price": "13.00",
      "quantity": 2
    }
  ],
  "subject_id": null
}
```

**Returned:**
```json
{
  "success": true,
  "cart_id": "e2993f84-a05e-4642-a222-5893aa8f4d15",
  "expires_at": "2026-06-09T07:06:59.000000Z"
}
```

---

## 3. View Cart

`GET /cart/show/:id` — Bearer token required.

**Returned:**
```json
{
  "data": {
    "cart_id": "0065c07c-5f4b-420e-8486-287b13a3f7c4",
    "status": "temporary",
    "purchase": {
      "name": "Compra temporal: 26AEHQYVIY",
      "locator": "26AEHQYVIY",
      "status": "temporary",
      "channel": "online",
      "is_gift": 0,
      "customer_first_name": null,
      "customer_last_name": null,
      "customer_id_document": null,
      "customer_phone": null,
      "customer_email": null,
      "uuid": "0065c07c-5f4b-420e-8486-287b13a3f7c4"
    },
    "items": [
      {
        "id": 250312,
        "visit_id": 25,
        "tour_id": 25,
        "visit_type": "general",
        "subtotal": "26.00",
        "discount": "0.00",
        "commissions": "2.00",
        "total": "26.00",
        "extrafields": {
          "get_extra_fields": 1,
          "extra_fields_per_ticket": true,
          "field_1": "Nombre completo",
          "field_2": "Documento de identidad D.N.I o pasaporte",
          "field_3": "",
          "field_4": "",
          "field_5": "",
          "extra_fields_description": "<p>Mostrar documento en el control de acceso</p>"
        },
        "visit": {
          "id": 25,
          "commercial_name": "Visita Catedral y Giralda (Incluye Iglesia de El Salvador)",
          "image": "https://admin.catedraldesevilla.servitickets.es/storage/01KQ7DQHBZVV3CBEWWH4HEN9GX.jpg"
        },
        "tour": { "id": 25, "name": "GENERAL-25" },
        "timetables": [
          {
            "id": 7115,
            "start_date": "2026-06-23T07:30:00.000000Z",
            "end_date": "2026-06-23T07:35:00.000000Z",
            "lounge_id": null
          }
        ],
        "tickets": [
          {
            "ticket_id": 34,
            "name": "Individual adultos",
            "price": "13.00",
            "quantity": 2,
            "total": "26.00",
            "tickets": [7019694, 7019695]
          }
        ],
        "individual_ticket_ids": [7019694, 7019695],
        "type": "general"
      }
    ],
    "commission": [
      { "id": 1, "name": "Gastos de gestión online", "price": "2.00", "tax": "0.35" }
    ],
    "subtotal": "26.00",
    "discount": "0.00",
    "tax": "0.00",
    "commission_total": "2.00",
    "commission_tax_total": "0.35",
    "total": "28.00",
    "dni_required": true,
    "school": false
  }
}
```

---

## 4. Remove Item from Cart

`POST /cart/removeitem` — Bearer token required.

**Sent:**
```json
{
  "cart_id": "e2993f84-a05e-4642-a222-5893aa8f4d15",
  "item_id": 250331
}
```

**Returned:**
```json
{
  "success": true,
  "error": "ITEM_REMOVED_SUCCESS",
  "message": "Item eliminado correctamente.",
  "expires_at": "2026-06-09T07:09:27.000000Z"
}
```
