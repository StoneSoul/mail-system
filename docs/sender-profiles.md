# Estrategia de perfiles de envío (Hostinger + backup Gmail)

## Objetivo

Permitir múltiples cuentas de envío, priorizando Hostinger y usando Gmail **solo** cuando se detecte un error de límite horario (por ejemplo, `too many messages`, `rate limit`, `exceeded hourly sending limit`).

## Modelo recomendado de datos

Guardar la configuración en dos niveles:

1. **Perfiles lógicos** (los que el SP elige)
2. **Cuentas SMTP físicas** (credenciales reales)

### 1) Perfil lógico (`sender_profiles`)

Campos sugeridos:

- `profile_key` (ej: `onboarding`, `facturacion`, `alerts`)
- `default_provider` (ej: `hostinger-main`)
- `fallback_policy` (ej: `hourly-limit-only`)
- `enabled`

Este perfil es lo que tu SP debería pasar al sistema cuando quiere usar una “cuenta puntual”, sin acoplarse a usuario/clave SMTP.

### 2) Cuenta SMTP (`smtp_accounts`)

Campos sugeridos:

- `account_key` (ej: `hostinger-main`, `gmail-backup-1`)
- `provider` (`hostinger` | `gmail`)
- `priority` (1, 2, 3...)
- `daily_limit` y/o `hourly_limit` (si lo conocés)
- `cooldown_until` (para pausar una cuenta)
- `enabled`
- `from_email`
- `smtp_host`, `smtp_port`, `secure`
- `smtp_user`, `smtp_pass` (idealmente en secret manager)

## Encolado del mail

Cuando insertes en `MailQueue`, guardar además:

- `sender_profile` (perfil pedido por el SP)
- `selected_account_key` (cuenta elegida para el intento actual)
- `attempt_number`
- `last_error_code` / `last_error_text`

## Regla de ruteo

1. Llega mail con `sender_profile=onboarding`.
2. Resolver perfil `onboarding` => cuenta primaria `hostinger-main`.
3. Enviar con Hostinger.
4. Si falla por error común (timeout, conexión, mailbox full), reintentar **misma cuenta** según retry policy.
5. Si falla por **límite horario** (clasificador específico), cambiar a la siguiente cuenta habilitada del perfil (ej: `gmail-backup-1`).

## Clasificación de error (clave)

No usar fallback por cualquier fallo. Crear una categoría explícita:

- `RATE_LIMIT_HOURLY` → habilita fallback a Gmail
- `SOFT` → retry normal, sin cambiar proveedor
- `HARD` → error definitivo

Patrones típicos para `RATE_LIMIT_HOURLY`:

- `452`
- `4.7.0`
- `rate limit`
- `too many messages`
- `exceeded hourly sending limit`

## Política para múltiples cuentas Gmail

Usar estrategia **round-robin con salud**:

- Elegir la siguiente cuenta Gmail habilitada y fuera de cooldown.
- Si una Gmail también pega límite, marcar `cooldown_until` y pasar a la próxima.
- Evitar concentrar todo en una sola cuenta.

## Contrato para SP (servicios que disparan mail)

Sí: conviene que cada SP indique perfil.

Payload recomendado:

```json
{
  "to": "cliente@dominio.com",
  "subject": "Bienvenido",
  "body": "...",
  "senderProfile": "onboarding"
}
```

Si no viene `senderProfile`, usar uno por defecto (`default`).

## Observabilidad mínima

Registrar por envío:

- perfil solicitado
- cuenta usada
- provider
- motivo de fallback (si hubo)
- código SMTP

Y alertar cuando:

- Hostinger entre en límite horario
- Se active fallback a Gmail
- Queden pocas cuentas habilitadas

## Recomendación práctica

1. Implementar primero `sender_profile` + clasificador `RATE_LIMIT_HOURLY`.
2. Habilitar fallback únicamente para esa categoría.
3. Después sumar pool de Gmail con round-robin y cooldown.

Con esto mantenés control fino, evitás “fallar abierto” y permitís que cada SP elija identidad de envío sin exponer credenciales.
