"use client";
import { UserButton } from "@clerk/nextjs";

/** Clerk's avatar menu, plus a link to our account page (the only way
 *  there on phones, where the header's text link is hidden). */
export default function ClerkUserButton({ accountLabel }: { accountLabel: string }) {
  return (
    <UserButton appearance={{ elements: { avatarBox: { width: 28, height: 28 } } }}>
      <UserButton.MenuItems>
        <UserButton.Link
          label={accountLabel}
          href="/app/account"
          labelIcon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M4 7h16M4 12h16M4 17h10"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          }
        />
      </UserButton.MenuItems>
    </UserButton>
  );
}
