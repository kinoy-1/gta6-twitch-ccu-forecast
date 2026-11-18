# GTA VI Twitch CCU Forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/kinoy-1/gta6-twitch-ccu-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/kinoy-1/gta6-twitch-ccu-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Entry for the [make.fun bounty "Forecast GTA VI's launch-day Twitch viewers hour by hour"](https://make.fun/c/gta6-twitch-ccu-forecast-01): a program that reads one case file (everything recorded up to the end of the first hour of GTA VI's release day, 19 November 2026 UTC) and forecasts the Twitch category's concurrent viewers for each of hours 2–24, as five quantiles per hour (0.05, 0.25, 0.5, 0.75, 0.95). Scored by mean pinball loss on the log scale.

## How it works

`main.ts` (Node 22, standard library only) models each hour as a **ratio to hour 1's print**, learned from the case's own `comparables` — past big console launches' release days:

- Every big console game unlocks at local midnight, rolling around the world, so launch-day Twitch curves share one shape in UTC hours: hour 1 holds only the UK / central-Europe / New Zealand unlock, hour 5 adds the US east coast, hour 9 the US west coast, and hours 17–22 are prime time in the Americas.
- The ratio curve depends strongly on how big hour 1 already is: a small hour-1 print grows several-fold into the evening, a huge one barely doubles. So for each forecast hour the program fits ln(viewers_h / viewers_1) against ln(viewers_1) over the comparables with a Gaussian-kernel weighted local-linear regression (bandwidth 2.0 in log space), evaluated at the case's own log hour-1 print and clamped to the range of launch sizes actually observed — a GTA-VI-sized print never extrapolates a line into the void. The median blends the local-linear fit 0.7 / 0.3 with the plain kernel-weighted mean.
- The spread is the fit's weighted residual standard deviation (floored at 0.25 log units, shrunk by 0.6), giving quantiles `q = p1 * exp(median + z * spread)`.
- Fallbacks keep every case valid: no usable comparables → persistence; a missing or zero hour-1 print → the last hourly history point, then 1 viewer. Output is deterministic and always satisfies the format (23 rows, finite quantiles, > 0, ≤ 1e9, non-decreasing).

## Practice results (local, answers from SullyGnome's public hourly averages)

| case | launch | this entry | house baseline |
| --- | --- | --- | --- |
| p00 | Marvel's Wolverine | 0.1738 | 0.7437 |
| p01 | Red Dead Redemption 2 | 0.1887 | 0.2868 |
| p02 | God of War Ragnarök | 0.1192 | 0.2146 |
| p03 | Marvel's Spider-Man 2 | 0.1779 | 0.3033 |
| **mean** | | **0.1649** | **0.3871** |

Mean pinball loss, lower is better. Typical miss 22–39% (baseline 42–189%), 90% coverage 0.83–1.00.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `*.in` in the input directory and writes `<id>.out` per case. Runs in ~0.3 s for all four practice cases; two runs write byte-identical output.

## License

MIT — see [LICENSE](LICENSE).
