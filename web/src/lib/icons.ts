import {
  ArrowDown,
  Bot,
  CalendarCheck,
  CalendarDays,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock,
  Code,
  Fingerprint,
  Hand,
  Headset,
  Image,
  Info,
  KeyRound,
  Layers,
  ListChecks,
  LockKeyhole,
  LogOut,
  MapPin,
  Menu,
  MessageCircle,
  Mic,
  MoonStar,
  Phone,
  Pin,
  Play,
  Plus,
  Repeat,
  RotateCcw,
  Save,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Store,
  UserRound,
  Wand,
  X,
  Zap,
  ChevronUp,
  Pause,
  Smartphone,
  LayoutGrid,
  createElement,
  type IconNode,
} from 'lucide';

const ICONS = {
  ArrowDown,
  Bot,
  CalendarCheck,
  CalendarDays,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  Clock,
  Code,
  Fingerprint,
  Hand,
  Headset,
  Image,
  Info,
  KeyRound,
  Layers,
  LayoutGrid,
  ListChecks,
  LockKeyhole,
  LogOut,
  MapPin,
  Menu,
  MessageCircle,
  Mic,
  MoonStar,
  Pause,
  Phone,
  Pin,
  Play,
  Plus,
  Repeat,
  RotateCcw,
  Save,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Store,
  UserRound,
  Wand,
  X,
  Zap,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGElement {
  const el = createElement(ICONS[name]);
  el.setAttribute('class', 'lucide');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  return el;
}

/** data-icon="Name" の要素に、アイコンを差し込む */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const name = el.dataset.icon as IconName;
    if (ICONS[name] && !el.querySelector('svg')) el.prepend(icon(name));
  });
}
