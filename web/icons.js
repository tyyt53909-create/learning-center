import library from 'lucide-static/icons/library-big.svg';
import grid from 'lucide-static/icons/layout-grid.svg';
import list from 'lucide-static/icons/list.svg';
import folder from 'lucide-static/icons/folder.svg';
import search from 'lucide-static/icons/search.svg';
import plus from 'lucide-static/icons/plus.svg';
import upload from 'lucide-static/icons/upload.svg';
import link from 'lucide-static/icons/link-2.svg';
import file from 'lucide-static/icons/file-text.svg';
import play from 'lucide-static/icons/play.svg';
import image from 'lucide-static/icons/image.svg';
import arrow from 'lucide-static/icons/arrow-up-right.svg';
import back from 'lucide-static/icons/arrow-left.svg';
import close from 'lucide-static/icons/x.svg';
import settings from 'lucide-static/icons/ellipsis.svg';
import sparkle from 'lucide-static/icons/sparkles.svg';
import clock from 'lucide-static/icons/clock-3.svg';
import puzzle from 'lucide-static/icons/puzzle.svg';
import chevron from 'lucide-static/icons/chevron-right.svg';
import star from 'lucide-static/icons/star.svg';
import menu from 'lucide-static/icons/menu.svg';
import book from 'lucide-static/icons/book-open.svg';
import shield from 'lucide-static/icons/shield.svg';
import pencil from 'lucide-static/icons/pencil.svg';
import trash from 'lucide-static/icons/trash-2.svg';
import refresh from 'lucide-static/icons/refresh-cw.svg';
import check from 'lucide-static/icons/check.svg';
import eye from 'lucide-static/icons/eye.svg';
import fileCode from 'lucide-static/icons/file-code.svg';
import download from 'lucide-static/icons/download.svg';
import waypoints from 'lucide-static/icons/waypoints.svg';
import database from 'lucide-static/icons/database.svg';
import filePlus from 'lucide-static/icons/file-plus.svg';
import listChecks from 'lucide-static/icons/list-checks.svg';
import sun from 'lucide-static/icons/sun.svg';
import moon from 'lucide-static/icons/moon.svg';
import info from 'lucide-static/icons/info.svg';
import typeIcon from 'lucide-static/icons/type.svg';
import layers from 'lucide-static/icons/layers.svg';
import graduationCap from 'lucide-static/icons/graduation-cap.svg';
import messageSquare from 'lucide-static/icons/message-square.svg';
import send from 'lucide-static/icons/send.svg';
import sliders from 'lucide-static/icons/sliders-horizontal.svg';
import wand from 'lucide-static/icons/wand-sparkles.svg';
import code2 from 'lucide-static/icons/code-2.svg';
import copy from 'lucide-static/icons/copy.svg';
import panelRight from 'lucide-static/icons/panel-right.svg';
import checkCircle from 'lucide-static/icons/circle-check-big.svg';
import globe from 'lucide-static/icons/globe.svg';
import bookmarkPlus from 'lucide-static/icons/bookmark-plus.svg';
import arrowUp from 'lucide-static/icons/arrow-up.svg';
import history from 'lucide-static/icons/history.svg';

const glyphs = {
  library, grid, list, folder, search, plus, upload, link, file, play, image, arrow, back, close,
  settings, sparkle, clock, puzzle, chevron, star, menu, book, shield, pencil, trash, refresh, check, eye, fileCode,
  download, waypoints, database, filePlus, listChecks, sun, moon, info, type: typeIcon, layers, graduationCap,
  messageSquare, send, sliders, wand, code2, copy, panelRight, checkCircle, globe, bookmarkPlus, arrowUp, history,
};
export const icon = Object.fromEntries(Object.entries(glyphs).map(([name, svg]) => [name, svg.replace(/<svg\b/, '<svg class="od-icon" aria-hidden="true"')]));
