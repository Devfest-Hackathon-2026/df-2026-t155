export interface DiscoveryDestination {
  id: string
  title: string
  theme: string
  region: string
  preferences: string
  image: string
  imageAlt: string
}

// Static photo themes only. These presets are drafts, not place matches or saved destinations.
export const discoveryDestinations: readonly DiscoveryDestination[] = [
  {
    id: 'castle',
    title: '名古屋城',
    theme: '城と歴史',
    region: '名古屋市',
    preferences: '名古屋の歴史や街並みを楽しみたい',
    image: '/images/nagoya/castle.webp',
    imageAlt: '青空の下に建つ名古屋城',
  },
  {
    id: 'atsuta',
    title: '熱田エリア',
    theme: '神社と緑',
    region: '名古屋市熱田区',
    preferences: '神社や緑の中をゆっくり歩きたい',
    image: '/images/nagoya/atsuta.webp',
    imageAlt: '緑に囲まれた熱田神宮の社殿',
  },
  {
    id: 'oasis',
    title: '栄エリア',
    theme: '街と水辺',
    region: '名古屋市中区',
    preferences: '栄の街並みや水辺の景色を楽しみたい',
    image: '/images/nagoya/oasis.webp',
    imageAlt: '水面に映るオアシス21',
  },
  {
    id: 'osaka-castle',
    title: '大阪城',
    theme: '大阪の城と街歩き',
    region: '大阪市',
    preferences: '大阪の街を歩いて歴史を楽しみたい',
    image: '/images/cities/osaka.webp',
    imageAlt: '大阪城の天守',
  },
  {
    id: 'tokyo-tower',
    title: '東京タワー',
    theme: '東京の名所めぐり',
    region: '東京都',
    preferences: '東京の名所をめぐりたい',
    image: '/images/cities/tokyo.webp',
    imageAlt: '東京タワー',
  },
]
