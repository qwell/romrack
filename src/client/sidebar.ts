import { type TitleGroup } from '../shared/titles.js';

let selectedFamily: string | null = null;
let detailSidebarOptions: DetailSidebarOptions | null = null;

type DetailSidebarOptions = {
    renderContent: (group: TitleGroup) => Node;
    onShow?: (group: TitleGroup) => void;
};

export function setupDetailSidebar(options: DetailSidebarOptions): void {
    detailSidebarOptions = options;
}

export function getSelectedDetailFamily(): string | null {
    return selectedFamily;
}

export function hasOpenDetailFamily(): boolean {
    return selectedFamily !== null;
}

export function closeDetailSidebar(sidebar: HTMLElement): void {
    selectedFamily = null;
    sidebar.hidden = true;
    document.body.removeAttribute('data-detail-open');
    sidebar.querySelector('.title-detail-body')?.replaceChildren();

    for (const group of document.querySelectorAll('.title-group')) {
        group.removeAttribute('data-selected');
    }
}

export function resetDetailSidebars(): void {
    selectedFamily = null;
    document.body.removeAttribute('data-detail-open');

    for (const sidebar of document.querySelectorAll<HTMLElement>(
        '.title-detail-sidebar'
    )) {
        sidebar.hidden = true;
        sidebar.querySelector('.title-detail-body')?.replaceChildren();
    }

    for (const group of document.querySelectorAll('.title-group')) {
        group.removeAttribute('data-selected');
    }
}

function showDetailSidebar(sidebar: HTMLElement, group: TitleGroup): void {
    if (!detailSidebarOptions) {
        throw new Error('showDetailSidebar options are required.');
    }

    selectedFamily = group.family;
    sidebar.hidden = false;
    document.body.setAttribute('data-detail-open', '');

    const title = sidebar.querySelector('.title-detail-title');
    if (title) {
        title.textContent = group.name;
    }

    const thumbnail = sidebar.querySelector<HTMLElement>(
        '.title-detail-thumbnail'
    );
    if (thumbnail) {
        thumbnail.replaceChildren();

        if (group.iconUrl) {
            const image = document.createElement('img');
            image.src = group.iconUrl;
            image.alt = group.name;
            thumbnail.append(image);
        }
    }

    const body = sidebar.querySelector('.title-detail-body');
    body?.replaceChildren(detailSidebarOptions.renderContent(group));
    detailSidebarOptions.onShow?.(group);

    for (const groupElement of document.querySelectorAll('.title-group')) {
        groupElement.toggleAttribute(
            'data-selected',
            groupElement.getAttribute('data-family') === group.family
        );
    }
}

export function toggleDetailSidebar(
    sidebar: HTMLElement,
    group: TitleGroup
): void {
    if (selectedFamily === group.family) {
        closeDetailSidebar(sidebar);
        return;
    }

    showDetailSidebar(sidebar, group);
}

export function buildDetailSidebar(): HTMLElement {
    const sidebar = document.createElement('aside');
    sidebar.className = 'title-detail-sidebar';
    sidebar.hidden = true;
    sidebar.setAttribute('aria-label', 'Title details');

    const header = document.createElement('div');
    header.className = 'title-detail-sidebar-header';

    const thumbnail = document.createElement('div');
    thumbnail.className = 'title-detail-thumbnail';

    const title = document.createElement('h2');
    title.className = 'title-detail-title';
    title.textContent = 'Title details';

    const closeButton = document.createElement('button');
    closeButton.className = 'title-detail-close';
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close title details');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', () => closeDetailSidebar(sidebar));

    const body = document.createElement('div');
    body.className = 'title-detail-body';

    header.append(thumbnail, title, closeButton);
    sidebar.append(header, body);

    return sidebar;
}

export function refreshOpenDetailSidebarForGroup(group: TitleGroup): void {
    if (!detailSidebarOptions) {
        return;
    }

    if (selectedFamily !== group.family) {
        return;
    }

    const body = document.querySelector<HTMLElement>('.title-detail-body');

    if (!body) {
        return;
    }

    body.replaceChildren(detailSidebarOptions.renderContent(group));
}
