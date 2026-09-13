const foundations = [
  "GitHub App webhooks",
  "Durable deployment state",
  "Rootless BuildKit builds",
  "Kubernetes Gateway API previews",
];

export default function Home() {
  return (
    <main>
      <section className="hero">
        <p className="eyebrow">FOUNDATION / M0</p>
        <h1>Preview environments without the platform sprawl.</h1>
        <p className="lede">
          PreviewForge turns a pull request into an isolated, disposable Kubernetes environment. The
          repository is ready for its first end-to-end deployment slice.
        </p>
        <ul>
          {foundations.map((foundation) => (
            <li key={foundation}>{foundation}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
