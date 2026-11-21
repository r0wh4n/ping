// Two rows of what Ping is not, sliding opposite ways. Pure CSS; still under
// reduced motion.
const WORDS = ["No phone number", "No feed", "No algorithm", "No ads, ever", "End-to-end encrypted texts", "Free", "Just your @handle"];

function Row({ outline }: { outline?: boolean }) {
  return (
    <div className={`marquee ${outline ? "marquee-rev" : ""}`}>
      {[0, 1].map((k) => (
        <div key={k} className="marquee-track">
          {WORDS.map((w) => (
            <span key={w} className={`marquee-word ${outline ? "marquee-outline" : ""}`}>
              {w}
              <span className="marquee-sep">✳</span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function Marquee() {
  return (
    <section className="overflow-hidden border-y border-border py-7 sm:py-9">
      <p className="sr-only">No phone number, no feed, no algorithm, no ads ever. End-to-end encrypted texts, free, just your @handle.</p>
      <div aria-hidden="true">
        <Row />
        <Row outline />
      </div>
    </section>
  );
}
