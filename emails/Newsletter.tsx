// React Email template for the daily/weekly digest. Resend renders this
// component to HTML at send time; the same component is also used by
// /api/newsletter/test for the "Send me a preview" button.

import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { TYPE_LABELS } from "@/lib/categorize";
import type { EventRecord } from "@/lib/types";
import type { Schedule } from "@/lib/newsletter/types";

export type NewsletterProps = {
  recipientFirstName?: string;
  regionDisplayName: string;
  schedule: Schedule;
  windowStart: string; // ISO
  windowEnd: string;   // ISO
  matched: EventRecord[];
  surprises: EventRecord[];
  unsubscribeUrl: string;
  manageUrl: string;
  subscribeUrl: string; // for forwarded-to recipients
  /** America/New_York etc. — formats dates in the recipient's region's TZ. */
  timeZone?: string;
};

const styles = {
  body: {
    backgroundColor: "#f6f7f9",
    margin: 0,
    padding: 0,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    color: "#111418",
  },
  container: {
    maxWidth: "600px",
    margin: "0 auto",
    backgroundColor: "#ffffff",
    padding: "0",
  },
  header: {
    padding: "32px 32px 16px",
  },
  brand: {
    fontSize: "13px",
    color: "#5b6470",
    fontWeight: 600,
    letterSpacing: "0.05em",
    textTransform: "uppercase" as const,
    margin: 0,
  },
  h1: {
    fontSize: "24px",
    fontWeight: 700,
    margin: "4px 0 8px",
    color: "#111418",
  },
  subhead: {
    fontSize: "14px",
    color: "#5b6470",
    margin: "0 0 8px",
  },
  section: {
    padding: "8px 32px",
  },
  dayHeading: {
    fontSize: "14px",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    color: "#5b6470",
    margin: "20px 0 8px",
  },
  event: {
    margin: "0 0 14px",
    paddingBottom: "14px",
    borderBottom: "1px solid #e3e6ea",
  },
  eventLast: {
    margin: "0 0 14px",
    paddingBottom: "0",
  },
  eventTime: {
    fontSize: "12px",
    color: "#5b6470",
    margin: 0,
  },
  eventTitle: {
    fontSize: "15px",
    fontWeight: 600,
    margin: "2px 0 4px",
    color: "#1d4ed8",
    textDecoration: "none",
  },
  eventMeta: {
    fontSize: "13px",
    color: "#5b6470",
    margin: 0,
  },
  surpriseBanner: {
    fontSize: "13px",
    color: "#5b6470",
    fontStyle: "italic" as const,
    margin: "16px 0 4px",
  },
  footer: {
    padding: "24px 32px 32px",
    fontSize: "12px",
    color: "#5b6470",
    lineHeight: "1.6",
  },
  footerLink: {
    color: "#1d4ed8",
    textDecoration: "underline",
  },
};

function formatDay(iso: string, tz?: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });
}

function formatTime(iso: string, allDay?: boolean, tz?: string): string {
  if (allDay) return "All day";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
}

function formatRange(start: string, end: string, schedule: Schedule, tz?: string): string {
  const s = new Date(start);
  const e = new Date(end);
  if (schedule === "daily") {
    return s.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: tz,
    });
  }
  return `${s.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: tz,
  })} – ${e.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: tz,
  })}`;
}

function groupByDay(events: EventRecord[]): Map<string, EventRecord[]> {
  const map = new Map<string, EventRecord[]>();
  for (const ev of events) {
    const day = ev.start.slice(0, 10);
    const list = map.get(day) ?? [];
    list.push(ev);
    map.set(day, list);
  }
  return map;
}

export function Newsletter(props: NewsletterProps) {
  const {
    recipientFirstName,
    regionDisplayName,
    schedule,
    windowStart,
    windowEnd,
    matched,
    surprises,
    unsubscribeUrl,
    manageUrl,
    subscribeUrl,
    timeZone,
  } = props;

  const previewText = matched.length
    ? `${matched.length} ${schedule === "daily" ? "today" : "upcoming"} · ${matched[0].title}`
    : `${surprises.length} surprise picks for ${regionDisplayName}`;

  const matchedByDay = groupByDay(matched);

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.header}>
            <Text style={styles.brand}>Goings On</Text>
            <Heading as="h1" style={styles.h1}>
              {regionDisplayName} · {formatRange(windowStart, windowEnd, schedule, timeZone)}
            </Heading>
            <Text style={styles.subhead}>
              {recipientFirstName ? `Hi ${recipientFirstName} — ` : ""}
              {matched.length > 0
                ? `${matched.length} event${matched.length === 1 ? "" : "s"} match your filters.`
                : "No events match your filters in this window."}
            </Text>
          </Section>

          {matchedByDay.size > 0 && (
            <Section style={styles.section}>
              {[...matchedByDay.entries()].map(([day, list]) => (
                <div key={day}>
                  <Text style={styles.dayHeading}>{formatDay(day + "T12:00:00Z", timeZone)}</Text>
                  {list.map((ev, i) => (
                    <div
                      key={ev.id}
                      style={i === list.length - 1 ? styles.eventLast : styles.event}
                    >
                      <Text style={styles.eventTime}>
                        {formatTime(ev.start, ev.allDay, timeZone)}
                        {ev.location?.town ? ` · ${ev.location.town}` : ""}
                      </Text>
                      <Link href={ev.url} style={styles.eventTitle}>
                        {ev.title}
                      </Link>
                      {ev.location?.venue && (
                        <Text style={styles.eventMeta}>
                          {ev.location.venue} · {TYPE_LABELS[ev.type]}
                        </Text>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </Section>
          )}

          {surprises.length > 0 && (
            <Section style={styles.section}>
              <Hr />
              <Text style={styles.surpriseBanner}>
                ✨ Outside your usual — you might also like
              </Text>
              {surprises.map((ev, i) => (
                <div
                  key={ev.id}
                  style={i === surprises.length - 1 ? styles.eventLast : styles.event}
                >
                  <Text style={styles.eventTime}>
                    {formatDay(ev.start, timeZone)} · {formatTime(ev.start, ev.allDay, timeZone)}
                    {ev.location?.town ? ` · ${ev.location.town}` : ""}
                  </Text>
                  <Link href={ev.url} style={styles.eventTitle}>
                    {ev.title}
                  </Link>
                  {ev.location?.venue && (
                    <Text style={styles.eventMeta}>
                      {ev.location.venue} · {TYPE_LABELS[ev.type]}
                    </Text>
                  )}
                </div>
              ))}
            </Section>
          )}

          <Section style={styles.footer}>
            <Hr />
            <Text style={{ margin: "8px 0" }}>
              You&rsquo;re getting this because you subscribed to {schedule} updates for{" "}
              {regionDisplayName}.{" "}
              <Link href={manageUrl} style={styles.footerLink}>
                Manage your preferences
              </Link>{" "}
              ·{" "}
              <Link href={unsubscribeUrl} style={styles.footerLink}>
                Unsubscribe
              </Link>
            </Text>
            <Text style={{ margin: "8px 0" }}>
              Got this from a friend?{" "}
              <Link href={subscribeUrl} style={styles.footerLink}>
                Subscribe for yourself
              </Link>
              .
            </Text>
            <Text style={{ margin: "8px 0", color: "#9aa3ad" }}>
              All event details are aggregated from venue websites. Click any title for the
              source listing.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default Newsletter;
