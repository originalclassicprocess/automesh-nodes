# Queue capacity (0.4.6)

File count and reserved storage are independent limits. Version 0.4.5 allows
only 16 pending files in total, even when the displayed byte budget is free.
Version 0.4.6 defaults to 128 files in total and 16 per originating linked
profile. One profile cannot consume every file slot. This is not a guaranteed
allocation of bytes: large files still share the node's storage budget.

Optional fields in the private node configuration, supported by the server,
Passenger, Linux and Windows adapters:

```json
"maxFiles": 128,
"maxFilesPerProfile": 16
```

Both must be integers from 1 to 1024, with the profile limit no larger than the
total. For example, 256 total / 32 per profile permits more files without a
rebuild. Stop the node, back up private configuration and data, edit these fields
in the existing configuration, then restart. Preserve all other fields and keys.
On Windows the configuration may be protected; do not replace it with plaintext
or reinitialize the node. These fields are validated runtime settings; a GUI
editor for them is not provided yet.

`maxBytes` is a separate, shared **reservation** budget, not physical disk usage:
encrypted chunks are stored as base64 JSON with metadata overhead. File space is
reserved in advance. Increasing the count does not increase this budget. New
file reservations leave one eighth of the budget (at most 8 MiB) for messages and
receipts. Existing reservations are not evicted. The panel displays both limits;
quota errors distinguish file count, profile count, envelopes and storage.

Partial uploads expire after one hour without a newly accepted chunk. Duplicate
chunks do not extend this timeout. On restart, file modification times preserve
the last progress time. The client may restart an expired upload using its local
copy. Accepted files are retained until the recipient's signed acknowledgement
or the original expiry; an offline recipient is not grounds for early deletion.
Files whose envelope deposit was rejected by quota become partial again, so they
can be retried or expire. Ambiguous disk errors keep the file to avoid data loss.

Lowering count limits keeps existing records and blocks new reservations until
usage falls below the limit. **Do not roll code back to 0.4.5 with more than 16
files present:** its older loader rejects that queue. Use a matching private
backup or let the queue drain before rollback. Never delete data to force startup.

No general administrator purge API is added. A sender can cancel its own pending
file; the node cannot issue a recipient's acknowledgement. Clearing node copies
does not cancel copies pending in browsers, which may be uploaded again.

## Русский

В 0.4.5 было всего 16 файловых слотов на всю ноду, независимо от свободных МБ.
В 0.4.6 по умолчанию — 128 на ноду и 16 на отправляющий профиль.
Параметры `maxFiles` и `maxFilesPerProfile` позволяют увеличить число без
пересборки: например, до 256 и 32. Нужен перезапуск после изменения существующей
приватной конфигурации. Максимум — 1024, квота профиля не выше общей.

Количество файлов и общий `maxBytes` ограничиваются отдельно. Место заранее
резервируется с учётом шифротекста, base64 и метаданных, поэтому это не размер
исходных файлов и не показание занятого диска. Новые загрузки оставляют до 8 МиБ
для сообщений. Квота файлов не гарантирует каждому профилю отдельный объём в МБ.

Незавершённая загрузка без прогресса освобождается через час; клиент сможет
начать её заново. Принятые файлы ждут подписанную квитанцию получателя или свой
срок доставки. Уже принятые данные не удаляются при снижении лимитов. Откат на
0.4.5 с очередью более 16 файлов невозможен без подходящей резервной копии либо
предварительной доставки этих файлов. Очистка ноды не отменяет отправку из браузера.

## Authenticated client status (0.4.12)

The existing `/outbox/status` reply adds optional message quota fields alongside file quota fields. Profile message count includes pending text and attachment-manifest envelopes from that authenticated originating profile. The count and byte limits use the same constants as admission enforcement. Global count and retained-record limits remain independent protections; neither is a personal allocation. The messenger shows only personal file/message usage and the associated node hostname. Old nodes without these fields show an unknown message limit, never invented free capacity.
