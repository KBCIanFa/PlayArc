📦 PlayArc — Playwright Automation Studio (Prototype)

PlayArc is an interactive automation testing studio built on top of Playwright. It provides a visual playground to build, run, inspect and analyse end-to-end tests right from your browser without writing code — ideal for prototyping, demoing test workflows and accelerating QA processes.

🔗 Live Prototype: https://kbcianfa.github.io/PlayArc/PlayArc-Prototype.html

🚀 Features

PlayArc Prototype includes the following core functional areas:

🧠 Dashboard

Provides an overview of your testing health, recent run activity and suite status.

🧪 Test Builder

Visually create and edit test steps using intuitive actions such as:

NAV

CLICK

FILL

ASSERT

WAIT

SCREENSHOT

DOM SELECT

EXECUTE JS
with both Manual and Script view support.

▶️ Live Runner

Run entire test suites or specific flows in real-time with browser feedback. Supports different browsers including Chrome, Firefox and Safari.

🔍 Element Inspector

Interactively explore DOM elements and capture reliable selectors through point-and-click inspection.

📊 Reports & Analytics

Visualise test trends, pass/fail rates and export reports for sharing or CI workflows.

🔁 Integrations

Prototype includes placeholders for popular integrations like:

GitHub Actions

Jira

Slack
…and flexible staging settings.

📌 Getting Started

Since this is a browser-hosted prototype, there’s no installation required. Simply open the URL in a modern browser:

https://kbcianfa.github.io/PlayArc/PlayArc-Prototype.html
Typical Workflow

Create a Project

Define a base URL and name.

Build Test Suites

Use the drag-and-drop or manual step builder to create tests.

Inspect Elements

Use the Element Inspector to generate reliable selectors.

Run Tests

Execute suites with the Live Runner and observe results.

Review Reports

Export analytics or view trends to refine stability.

📦 Project Structure

The prototype contains UI modules for:

/Dashboard
/Test Builder
/Live Runner
/Inspector
/Reports
/Settings

All UI content updates dynamically without full page reloads.

🧩 Technologies

PlayArc Prototype is built using:

🧪 Playwright test automation concepts

🎨 Interactive browser UI (HTML/CSS/JS)

🧠 Self-healing selectors with fallback insights

📊 Built-in analytics widgets for trends and suite status

🤝 Contributing

This prototype is a great start! To contribute:

Fork the repo

Create a branch: feat/<your-feature>

Add tests and documentation

Submit a pull request

Suggestions and improvements — from UI enhancements to deeper integrations — are welcome!

❓ Known Limitations

Prototype does not persist test suites across sessions.

Back-end integrations (e.g., CI triggers) are conceptual placeholders.

Some analytics data is mock/demo only.
