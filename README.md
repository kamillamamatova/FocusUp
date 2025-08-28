# FocusUp

A simple, embeddable timer for students and makers: count up to your daily goal, log sessions, and keep streaks alive. <br>
Designed for students, developers, and makers who want accountability inside **Notion** or the browser.

---

## Features
- **Count-up timer** toward a daily goal (e.g. 2 hours)
- **Elapsed / Remaining / Overtime** views
- **Finish Day** logs your minutes and resets for tomorrow
- **Daily streaks** (current & best)
- **History log** (view your past 30 days)
- **Lightweight**: no backend, works entirely in browser (localStorage)
- **Embeddable** in notion with '/embed'

---

## Instalation
1. Clone this repository:
    ''' bash
    git clone https://github.com/yourusername/focusup.git
    cd focusup
2. Open focus-timer.html in your browser.
3. (Optional) Deploy to GitHub Pages, Netlify, or Vercel to get a shareable URL.

---

## Usage
- **Start / Pause** begin or pause a focus session
- **Reset** clear today's timer (does not delete history)
- **Finish Day** log today's total, update streaks, and reset
- **Goal (mins)** set your daily focus target
- **Sessions today** track how many separate work blocks you've done <br>
**Pro tip** Use this as an /embed block in Notion for a seamless planner + timer workflow.

---

## Data & Storage
- All data (sessions, streaks, history) is stored in your browser localStorage.
- Data persists between sessions but is per-device.
- To migrate, you can export/import the localStorage key focusTimer.v1.

---

## Contributing
Pull requests and feature requests are welcome! <br>
Feel free to open an issue if you’d like to suggest improvements.

---

## License
Created and maintained by **Kamilla Mamatova** <br>
If you found this helpful, feel free to star the repo and share!