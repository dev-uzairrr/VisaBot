# cf-bot Commands

## Install dependencies

```bash
npm install
```

## Run project

```bash
npm run start
```

## Account database commands

### List accounts

```bash
npm run db:list
```

### Add account

```bash
npm run db:add -- --label=acc1 --login_email=user@example.com --login_password=secret --website_url=https://example.com/schedule
```

### Update account

```bash
npm run db:update -- --id=1 --active=0
```

Example with more fields:

```bash
npm run db:update -- --id=1 --category_name="Schengen VISA" --headless=true --slot_wait_ms=180000
```

### Delete account

```bash
npm run db:delete -- --id=1
```

## Booking status commands

### Show latest status for all accounts

```bash
npm run db:status
```

### Show latest status for active accounts only

```bash
npm run db:status -- --only=active
```

### Show latest status for a specific status value

```bash
npm run db:status -- --status=FAILED
```

Other status examples:

```bash
npm run db:status -- --status=BOOKED
npm run db:status -- --status=IN_PROGRESS
npm run db:status -- --status=NOT_BOOKED
```

### Cleanup smoke-test status rows

```bash
npm run db:status:cleanup
```
