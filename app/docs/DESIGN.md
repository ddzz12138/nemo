# Nemo interface

A quiet phone interface using the owner's phone layout and the Nemo website's
warm palette. On 27 October the owner replaced the white background direction
with the site's peach-to-cream wash: #E6CDB9 through #F0DACA and #FAEADE to
#FFFAF4. Use warm cream/peach surfaces, charcoal text (#20242A), system sans-serif
type and generous space.
The header has a menu on the left, centred lower-case nemo and the current
person's name on the right. Use orange (#F88009) outgoing bubbles and pale-peach
(#FFF0E4) Nemo replies with small tails. Do not imitate phone hardware or system
status bars inside the web app.

Chat is the primary interface. Keep the composer as a compact pill at the bottom.
The menu holds Chat, History, Memory, Tasks, Reminders, Connected accounts and
setup help. The person's name opens profile/family/devices, passkeys, account and
computer settings. Contextual actions stay on their own pages; the first-time
desktop wizard stays a guided sequence. Use one clear primary action per state.
The shared header and navigation live in navigation.js/navigation.css, rather
than independent copies on each page. Keep real activity expandable by the reply.

Memory is understandable facts plus a derived summary. Editing or highlighting
the summary corrects its underlying facts. Separate source caches from personal
facts. Surface sources and dates; keep database terminology in optional details.

Use real state labels and readable errors. Maintain 44px touch targets, visible
focus, semantic labels, text contrast, safe-area spacing and small-screen layouts.
Never manufacture activity, confirmations, backend availability or match counts.

Reference screenshots from the private installation are not redistributable
assets. Use the original Nemo icon and synthetic content for public examples.
