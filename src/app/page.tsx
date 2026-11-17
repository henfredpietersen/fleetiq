import { redirect } from "next/navigation";

// The proxy sends signed-out visitors to /sign-in; signed-in users land on the placeholder home.
export default function Root() {
  redirect("/home");
}
