# dsh-superagent

This fork adds **personal mode, a Web task inbox, Windows support, and a OneBot v11 QQ Source (NapCat / SnowLuma)** to the
upstream research prototype. Repository mode remains available. Personal mode runs
with a model and a local execution environment, and accepts tasks directly from
the DSH Web panel. See [Personal mode](docs/personal.md) and
[Windows setup](docs/windows.md). The `linux` branch carries the same features with
[Linux and CNB setup](docs/linux.md), a reproducible development image and Linux CI.

This fork also includes QQ file and visual-media input, immutable task artifacts,
Router status replies, semantic QQ task routing and an external Watchdog. See
[QQ / OneBot v11](docs/qq-napcat.md), [Watchdog](docs/watchdog.md), and the
[article alignment audit](docs/article-alignment-audit.md) for implementation evidence,
verification and deployment conditions.

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu or QQ through a OneBot v11 interface. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

This local checkout includes Windows compatibility maintenance. See
[Windows setup](docs/windows.md) for PowerShell 7, native service management and
the dedicated-profile workflow. See [Linux and CNB setup](docs/linux.md) for the maintained Linux deployment.

QQ can be connected through NapCat or SnowLuma's OneBot v11 WebSocket interface. See
[QQ through OneBot v11](docs/qq-napcat.md) for installation, connection modes,
authorization, and first-task steps.

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [Personal mode](docs/personal.md): Web tasks, follow-ups, and local results
- [Personal assistant](docs/personal-assistant.md): goals, commitments, confirmed memory, scheduled checks, attention and exact action approval
- [Task rooms](docs/task-rooms.md): group-style supervision, peer Worker subscriptions and directed owner input
- [QQ through OneBot v11](docs/qq-napcat.md): QQ Source setup and routing

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
