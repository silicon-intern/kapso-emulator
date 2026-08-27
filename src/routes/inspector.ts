import type { InspectorTab, RouteContext } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { getKapsoStore } from "./../store.js";

const SERVICE_LABEL = "Kapso";
const TABS: InspectorTab[] = [
  { id: "messages", label: "Messages", href: "/?tab=messages" },
  { id: "webhooks", label: "Webhooks", href: "/?tab=webhooks" },
  { id: "conversations", label: "Conversations", href: "/?tab=conversations" },
];

export function inspectorRoutes({ app, store }: RouteContext): void {
  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "messages";
    const active = TABS.some((tab) => tab.id === requested) ? requested : "messages";
    const body =
      active === "webhooks"
        ? webhooksView()
        : active === "conversations"
          ? conversationsView()
          : messagesView();
    return c.html(renderInspectorPage("Kapso Inspector", TABS, active, body, SERVICE_LABEL));
  });

  function messagesView(): string {
    const rows = getKapsoStore(store)
      .messages.all()
      .sort((a, b) => b.id - a.id)
      .slice(0, 200)
      .map((message) => [
        escapeHtml(message.wamid),
        escapeHtml(message.direction),
        escapeHtml(message.message_type),
        escapeHtml(message.customer_phone),
        escapeHtml(message.content ?? ""),
        escapeHtml(message.created_at),
      ]);
    return section(
      "Messages",
      table(["WAMID", "Direction", "Type", "Customer", "Content", "Created"], rows, "No messages."),
    );
  }

  function webhooksView(): string {
    const rows = getKapsoStore(store)
      .webhookDeliveries.all()
      .sort((a, b) => b.id - a.id)
      .slice(0, 200)
      .map((delivery) => [
        escapeHtml(delivery.event),
        escapeHtml(delivery.wamid ?? ""),
        escapeHtml(delivery.status_code == null ? "" : String(delivery.status_code)),
        delivery.success ? "ok" : escapeHtml(delivery.error ?? "failed"),
        escapeHtml(delivery.created_at),
      ]);
    return section(
      "Webhook deliveries",
      table(["Event", "WAMID", "Status", "Outcome", "Created"], rows, "No deliveries."),
    );
  }

  function conversationsView(): string {
    const rows = getKapsoStore(store)
      .conversations.all()
      .sort((a, b) => b.id - a.id)
      .map((conversation) => [
        escapeHtml(conversation.kapso_conversation_id),
        escapeHtml(conversation.phone_number_id),
        escapeHtml(conversation.customer_phone),
        escapeHtml(conversation.contact_name ?? ""),
        conversation.active ? "active" : "rotated",
      ]);
    return section(
      "Conversations",
      table(
        ["Kapso id", "Phone number id", "Customer", "Name", "State"],
        rows,
        "No conversations.",
      ),
    );
  }
}

function section(title: string, body: string): string {
  return `<h2>${escapeHtml(title)}</h2>${body}`;
}

function table(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const body = rows
    .map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="inspector-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
