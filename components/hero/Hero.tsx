import Image from "next/image";
import Link from "next/link";

import { PixelCloudField } from "./PixelCloudField";

export function Hero() {
  return (
    <main className="hero">
      <PixelCloudField />

      <header className="hero-header">
        <Link className="brand-mark" href="/" aria-label="Zymbly home">
          <Image
            src="/zymbly-logo.svg"
            alt=""
            width={79}
            height={96}
            priority
          />
        </Link>
      </header>

      <section className="hero-copy" aria-labelledby="hero-title">
        <h1 id="hero-title">Know what&apos;s next.</h1>
      </section>
    </main>
  );
}
