# A játék a felhőben (Oracle Cloud, Always Free)

A szerver egy ingyenes Oracle-gépen fut (Ampere ARM, Ubuntu 24.04, Frankfurt). A játékosok
ugyanúgy a Cloudflare alagúton át érik el (`tank.` és `tankbeta.` cím), csak az alagút
végpontja most a felhős gépen van, nem otthon. A gépen nincs nyitott játékport: a szerver
csak a gépen belülről érhető el (127.0.0.1:8787), kívülről csak SSH (22) van nyitva, és oda
is csak kulccsal lehet belépni.

## Mi hol van

| Hol | Mi |
|---|---|
| `felho.txt` (gyökér, git-ből kihagyva) | a gép címe: `ubuntu@<nyilvános IP>` |
| `%USERPROFILE%\.ssh\oracle_tank` | a belépő kulcs titkos fele – senkinek nem szabad odaadni |
| `/opt/tank/app` | a játék és a szerver (minden frissítéskor kicserélődik) |
| `/opt/tank/data` | fiókok, adminok (`admins.txt`), nyitott játékok |
| `/opt/tank/logs` | a statisztika napló |
| `/opt/tank/backup` | napi mentés az adatokról (14 napig) |
| `mentes\` (gyökér, git-ből kihagyva) | minden frissítéskor ide is letöltődik az adatok másolata |
| `/etc/cloudflared` | az alagút beállítása és kulcsa |

## Frissítés

`felho-frissites.bat`: összeállítja a játékot (a `.deploy\` mappába, a helyi `dist\`-et nem
bántja), feltölti, kicseréli a régi változatot és újraindítja a szervert. Ha az új változat
nem indul el, magától visszaáll az előzőre. A futó meccsek a frissítéskor megszakadnak, ezért
akkor érdemes, amikor senki nem játszik.

Ha a `deploy\tank.service` vagy a `deploy\tank-mentes` változott: `node scripts\deploy.mjs --setup`.

## Hasznos parancsok (a projekt mappájából, Git Bash-ben)

```
ssh -i ~/.ssh/oracle_tank $(head -1 felho.txt)                       # belépés a gépre
ssh -i ~/.ssh/oracle_tank $(head -1 felho.txt) 'journalctl -u tank -n 50'   # a szerver naplója
ssh -i ~/.ssh/oracle_tank $(head -1 felho.txt) 'sudo systemctl restart tank' # újraindítás
ssh -i ~/.ssh/oracle_tank $(head -1 felho.txt) 'sudo systemctl status cloudflared' # az alagút állapota
```

Az adminok listája a gépen: `/opt/tank/data/admins.txt` (szerkesztés után `sudo systemctl restart tank`).

## Vissza az otthoni gépre

1. A felhős szerver és alagút leállítása:
   `ssh -i ~/.ssh/oracle_tank $(head -1 felho.txt) 'sudo systemctl disable --now tank cloudflared'`
2. Az adatok visszamásolása: a legutóbbi `mentes\felho-*.tgz` tartalma (`data\`, `logs\`) a projekt mappájába.
3. `szerver.bat` – figyelmeztet, hogy van `felho.txt`; ha a felhős szerver már le van állítva, `I`.

Egyszerre soha ne fusson a két szerver: a közös alagút miatt a játékosok hol az egyikre, hol a
másikra kerülnének, két külön fiók- és statisztikakészlettel.

## Ingyenesség

A gép az Oracle „Always Free” keretén belül van (A1: legfeljebb 2 OCPU és 12 GB összesen,
200 GB lemez, 10 TB/hó forgalom). A fiókot nem szabad „Pay As You Go”-ra váltani. Ellenőrzés:
Billing & Cost Management → Cost Analysis (0 kell legyen), illetve Budgets (riasztás).
